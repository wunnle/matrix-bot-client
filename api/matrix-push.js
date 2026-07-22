/**
 * Matrix HTTP Push Gateway — /_matrix/push/v1/notify
 * https://spec.matrix.org/v1.9/push-gateway-api/
 *
 * Receives push notifications from matrix.org and delivers them as Web Push
 * to the subscription stored under push_subscriptions/{hash}.json in Vercel Blob.
 */
import webpush from "web-push";
import { apnsSend, apnsSendWithFallback, apnsConfigured, isEnvMismatch, APNS_BUNDLE_ID, LIVE_ACTIVITY_TOPIC } from "./_apns.js";
import { liveActivityEntry, clearTokens, recordPushResult } from "./live-activity.js";


const ROOM_AVATARS = {
  "!vjoGMHloXyNobvgGaK:matrix.org": "mxc://matrix.org/tOIBhgtMxpMQMmADcYIcprnh",
  "!PuoXYYposdTSyiwnkx:matrix.org": "mxc://matrix.org/gEzjnnOcBuppMPJoijpZAkef",
  "!mhNSsDLFdlzGIGyRgi:matrix.org": "mxc://matrix.org/pqhnMFYAoWmsukcvrjdujQdG",
  "!iEbYoSfZgfHLeSKLei:matrix.org": "mxc://matrix.org/paDQdclqzpfVYCDZiWPPMzID",
  "!tCuyENMznYGVHZQiod:matrix.org": "mxc://matrix.org/QcMeBkdMIjZGVOcwNTUkiqnI",
  "!DpRWqhWOHJAxyvjOGI:matrix.org": "mxc://matrix.org/bAFLWJDiBQExiECpdDNHVOKl",
};

function mxcToProxyUrl(mxc) {
  if (!mxc) return null;
  return `https://construct.kafagoz.com/api/media?mxc=${encodeURIComponent(mxc)}`;
}

webpush.setVapidDetails(
  "mailto:sinanaksay@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/* ── APNs (native iOS app) ─────────────────────────────────────────────
   Pushkeys that don't parse as a Web Push subscription are APNs device
   tokens. Delivery uses token-based auth (ES256 JWT from the .p8 key).
   Env: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_TOPIC. */

/* Bender writes markdown into `body`; notifications are plain text everywhere
   (APNs and Web Push both), so "**9-4**" would render literally. Strip the
   common markers rather than ship the syntax to the lock screen.

   Deliberately does NOT touch `_underscores_`: bender talks about code, and
   stripping those would mangle snake_case identifiers. Asterisk italics are
   only stripped when they aren't adjacent to word characters, for the same
   reason. */
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "[code]")            // fenced blocks
    .replace(/`([^`\n]+)`/g, "$1")                   // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")        // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")         // links → link text
    // Bold, `**` only — `__bold__` is excluded so Python dunders survive.
    .replace(/(?<![\w*])\*\*(?!\s)(.+?)(?<!\s)\*\*(?![\w*])/g, "$1")
    // Italic. The (?!\s) / (?<!\s) guards match real markdown rules and keep
    // "5 * 3 = 15 and 2 * 4" from being read as an emphasis span.
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")                     // strikethrough
    .replace(/^#{1,6}\s+/gm, "")                     // headings
    .replace(/^>\s?/gm, "")                          // blockquotes
    .replace(/^\s*[-*+]\s+/gm, "• ")                 // bullets
    .trim();
}

/* Bender marks quick-reply CTAs in the body as [[label]]. Mirror the web app's
   parseActions (src/components/ChatView.tsx) so the Live Activity can render the
   same one-tap buttons: pull the labels out and strip the markers from the text.
   [[label]] / [[button]] are the doc-example placeholders and aren't real CTAs. */
function parseActions(text) {
  const actions = [];
  const stripped = text
    .replace(/\[\[([^\]]{1,40})\]\]/g, (match, label) => {
      const t = label.trim().toLowerCase();
      if (t === "label" || t === "button") return match;
      actions.push(label.trim());
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text: stripped, actions };
}

function parseWebPushKey(pushkey) {
  try {
    const sub = JSON.parse(pushkey);
    return sub?.endpoint ? sub : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { notification } = req.body || {};
  if (!notification) return res.status(400).json({ rejected: [] });

  const { room_id, room_name, content, sender_display_name, devices = [], counts } = notification;

  // Badge-only update — no actual message to show
  if (!room_id || !content?.body) return res.status(200).json({ rejected: [] });

  // Tool progress / thinking message — suppress notification
  const TOOL_PROGRESS_LINE = /^(?:\*\s*)?\S\S?\s+\w[\w./-]*(?::\s+".{0,80}"(?:\s+\(×\d+\))?|\.\.\.)\s*$/u;
  const isThinking = content.body.split('\n').filter(l => l.trim()).every(l => TOOL_PROGRESS_LINE.test(l.trim()));
  if (isThinking) return res.status(200).json({ rejected: [] });

  const title = room_name || "Hermes";
  // Strip before truncating, so the cut can't land mid-marker and leave a
  // dangling "**".
  //
  // iOS collapses this to a few lines and reveals the rest on long-press, so
  // the limit only needs to respect the APNs 4KB payload ceiling — cutting at
  // 100 meant expanding a notification showed nothing extra.
  const rawBody = content?.body
    ? stripMarkdown(content.body).slice(0, 1200)
    : sender_display_name
    ? `New message from ${sender_display_name}`
    : "New message";
  // Pull the [[CTA]] chips out once — reused for the Live Activity content-state
  // and the notification's quick-reply buttons. `body` is the marker-free text.
  const { text: body, actions } = parseActions(rawBody);

  const rejected = [];

  // Push the reply into any running Live Activity for this room, and report
  // whether it was delivered. Independent of the per-device loop below: Live
  // Activity tokens are per-activity, not per Matrix device, so they aren't in
  // `devices`. Awaited before that loop so a delivered Live Activity can
  // suppress the duplicate alert on the same phone.
  const liveActivityDelivered = await (async () => {
    if (!apnsConfigured()) return false;
    const entry = await liveActivityEntry(room_id);
    if (!entry) return false;

    // `update`, not `end`: ending finishes the activity after a single reply,
    // so a follow-up message had nothing left to update. Every message for the
    // room now refreshes the activity, and the token is kept (see below).
    //
    // No `dismissal-date` — it is only meaningful for `end`, and the one time
    // this payload carried one it never delivered. Worth revisiting with the
    // test endpoint if auto-dismissal is wanted; the earlier reading of it was
    // confounded by a test that ended the activity first.
    //
    // stale-date is pushed forward on every update so the activity dims only
    // after a genuine lull rather than 15 minutes after the ask.
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      aps: {
        timestamp: nowSec,
        event: "update",
        "stale-date": nowSec + 900,
        // Keys must match ConstructActivityAttributes.ContentState exactly —
        // a mismatch is dropped silently by ActivityKit. `question` is echoed
        // from the registry so it stays visible (faded) above the reply.
        // `roomId` rides along so a button can send back to this room.
        "content-state": {
          status: "Reply",
          question: entry.question || "",
          detail: body.slice(0, 300),
          roomId: room_id,
          actions: actions.slice(0, 3),
        },
        // An `alert` block turns this into an alerting update: iOS plays sound
        // and a haptic and surfaces the activity prominently (Dynamic Island
        // expands) instead of updating it silently. The push-payload equivalent
        // of ActivityKit's alertConfiguration, which the app can't set while
        // suspended.
        alert: {
          title: title,
          body: body.slice(0, 150),
          sound: "default",
        },
      },
    };

    const r = await apnsSendWithFallback(entry.token, payload, {
      topic: LIVE_ACTIVITY_TOPIC,
      pushType: "liveactivity",
    });
    await recordPushResult(room_id, {
      results: [{ env: r.env, status: r.status, body: r.body, apnsId: r.apnsId }],
      topic: LIVE_ACTIVITY_TOPIC,
    });
    // A dead token (activity ended/dismissed, grace window passed) comes back
    // 410 Unregistered — clear it so it can't linger and suppress this room's
    // notifications. Otherwise the token is kept: it's what lets the next
    // message update the same activity.
    if (r.status === 410 || (r.status === 400 && (r.body || "").includes("BadDeviceToken"))) {
      await clearTokens(room_id);
      return false;
    }
    return r.status === 200;
  })();

  await Promise.all(
    devices.map(async (device) => {
      const pushkey = device.pushkey;
      if (!pushkey) return;

      const subscription = parseWebPushKey(pushkey);

      if (!subscription) {
        // APNs device token (native iOS app)
        if (!apnsConfigured()) {
          return; // APNs not configured — don't reject, token may be valid later
        }
        // Suppress the alert on the phone that is showing the Live Activity: it
        // already got an alerting Live Activity push (sound + haptic) for this
        // same message, so a banner here is a second buzz. Web Push (other
        // devices, e.g. desktop) is untouched — this only skips the native
        // iOS alert, and only when the Live Activity push actually landed.
        if (liveActivityDelivered) return;
        // Sender as the title reads better than the room on iOS; the room
        // becomes the subtitle. Falls back to the web-push title when the
        // notification carries no sender.
        const apnsPayload = {
          aps: {
            alert: {
              title: sender_display_name || title,
              // Only when it adds something: in a one-bot room the sender and
              // the room are both "Bender", which rendered the name twice.
              ...(sender_display_name && room_name && room_name !== sender_display_name
                ? { subtitle: room_name }
                : {}),
              body,
            },
            sound: "default",
            "thread-id": room_id,
            // Surfaces through Focus/DND — an agent reply is worth interrupting for.
            "interruption-level": "time-sensitive",
            // Enables the inline Reply action registered in AppDelegate.swift.
            category: "MESSAGE",
            ...(counts?.unread != null ? { badge: counts.unread } : {}),
          },
          roomId: room_id,
          // Original markdown for the notification content extension to render
          // on long-press, with the [[CTA]] markers stripped (the extension
          // draws those as buttons instead). aps.alert.body stays stripped for
          // the collapsed view, which is plain text only. Both capped well
          // inside the 4KB APNs payload ceiling.
          md: content.body ? parseActions(content.body.slice(0, 1200)).text : null,
          // Quick-reply chips for the content extension to render as one-tap
          // buttons (long-press the notification). Same labels as the Live
          // Activity's; only present when bender suggested any.
          ...(actions.length ? { actions: actions.slice(0, 3) } : {}),
          sender: sender_display_name || null,
        };
        // Dev builds register sandbox tokens; production/TestFlight builds
        // register production ones. Try production first, fall back to sandbox
        // on either mismatch Apple reports:
        //   BadDeviceToken          — production key, but a sandbox token
        //   BadEnvironmentKeyInToken — sandbox-only auth key hitting production
        let r = await apnsSend("api.push.apple.com", pushkey, apnsPayload);
        if (isEnvMismatch(r)) {
          r = await apnsSend("api.sandbox.push.apple.com", pushkey, apnsPayload);
        }
        if (r.status === 410 || (r.status === 400 && r.body.includes("BadDeviceToken"))) {
          rejected.push(pushkey);
        }
        return;
      }

      const icon = mxcToProxyUrl(ROOM_AVATARS[room_id]);
      const payload = JSON.stringify({
        title,
        body,
        roomId: room_id || null,
        icon,
        unread: counts?.unread ?? null,
      });

      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          rejected.push(pushkey);
        }
      }
    })
  );

  // Matrix spec requires returning rejected pushkeys so the homeserver unregisters them
  res.status(200).json({ rejected });
}
