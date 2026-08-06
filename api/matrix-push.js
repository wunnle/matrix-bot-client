/**
 * Matrix HTTP Push Gateway — /_matrix/push/v1/notify
 * https://spec.matrix.org/v1.9/push-gateway-api/
 *
 * Receives push notifications from the homeserver and fans them out to each
 * pushkey it provides: Web Push subscriptions (browsers/PWA) and APNs device
 * tokens (native iOS), plus any running Live Activity for the room.
 */
import webpush from "web-push";
import { apnsSend, apnsSendWithFallback, apnsConfigured, isEnvMismatch, APNS_BUNDLE_ID, LIVE_ACTIVITY_TOPIC } from "./_apns.js";
import { liveActivityEntry, clearTokens, recordPushResult, startLiveActivityIfNeeded, recordNotify, activeClients } from "./live-activity.js";


const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix-client.matrix.org";
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;

function mxcToProxyUrl(mxc) {
  if (!mxc) return null;
  return `https://construct.kafagoz.com/api/media?mxc=${encodeURIComponent(mxc)}`;
}

// Room avatars are resolved live from the homeserver — the account's own token
// is a member of every room it receives pushes for. Cached in-memory so warm
// invocations don't re-query matrix.org for every message; avatars change rarely.
const avatarCache = new Map(); // roomId -> { mxc, ts }
const AVATAR_TTL_MS = 10 * 60 * 1000;

async function roomStateEvent(roomId, type, stateKey = "") {
  if (!ACCESS_TOKEN) return null;
  const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/${encodeURIComponent(stateKey)}`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// The room's own avatar, falling back to the sender's (covers DM-style rooms
// with no explicit m.room.avatar). null → the notification stays a plain banner.
async function resolveRoomAvatarMxc(roomId, sender) {
  const hit = avatarCache.get(roomId);
  if (hit && Date.now() - hit.ts < AVATAR_TTL_MS) return hit.mxc;
  let mxc = null;
  const roomAvatar = await roomStateEvent(roomId, "m.room.avatar");
  if (roomAvatar?.url) mxc = roomAvatar.url;
  else if (sender) {
    const member = await roomStateEvent(roomId, "m.room.member", sender);
    if (member?.avatar_url) mxc = member.avatar_url;
  }
  avatarCache.set(roomId, { mxc, ts: Date.now() });
  return mxc;
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

  const { room_id, room_name, content, sender, sender_display_name, devices = [], counts } = notification;

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

  // Which clients are in the foreground, and where. Two rules follow, so which
  // device it is matters, not just that something is active:
  //   • the active device itself still wants other rooms — only the room
  //     already on its screen would be noise;
  //   • every other device stays quiet, because you're reading elsewhere.
  //
  // Empty on any error, so an unreadable heartbeat notifies rather than mutes.
  const active = await activeClients(75_000);
  // A client whose pushkey matches one of this user's push devices is that
  // device; anything else (a browser without notifications) is "somewhere else"
  // by definition, since it is never a device being notified.
  const nativePushkeys = new Set(
    devices.map((d) => d.pushkey).filter((k) => k && !parseWebPushKey(k))
  );
  const activeNativeHere = active.find((c) => nativePushkeys.has(c.pushkey));
  const activeNonNative = active.some((c) => !nativePushkeys.has(c.pushkey));
  // Nothing on the phone while you're reading on another device, and nothing
  // for a room the phone itself already has open.
  const suppressLiveActivity = activeNonNative || activeNativeHere?.roomId === room_id;

  // Resolved once and shared by the APNs payload (service extension) and the
  // Web Push icon.
  const avatarUrl = mxcToProxyUrl(await resolveRoomAvatarMxc(room_id, sender));

  // Push the reply into any running Live Activity for this room, and report
  // whether it was delivered. Independent of the per-device loop below: Live
  // Activity tokens are per-activity, not per Matrix device, so they aren't in
  // `devices`. Awaited before that loop so a delivered Live Activity can
  // suppress the duplicate alert on the same phone.
  const liveActivityDelivered = await (async () => {
    if (!apnsConfigured()) return false;
    // Reading on another device (or already looking at this room): don't touch
    // the activity at all. Dropping only the alert still refreshed it on the
    // lock screen, which is exactly what "no Live Activities" rules out. The
    // cost is that it holds its last message until you're away again.
    if (suppressLiveActivity) return false;
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
        // roomName rides along because one activity serves every room now: it
        // has to re-label itself for whichever room this message came from.
        "content-state": {
          status: "Reply",
          question: entry.question || "",
          detail: body.slice(0, 300),
          roomId: room_id,
          roomName: room_name || title,
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

  // Push-to-start (iOS 17.2+) creates an activity for a room the app has never
  // opened, which is what extends Live Activities beyond the ones the app
  // starts itself. Set LIVE_ACTIVITY_PUSH_TO_START=0 to switch it off.
  //
  // Deliberately does NOT suppress this message's notification, even though the
  // start push carries its own alert: APNs answers 200 whether or not iOS goes
  // on to create the activity, so "accepted" is not evidence of anything, and
  // acting on it silently dropped a message. The cost is a double alert on the
  // first message in a room (once per cooldown); the alternative risks a
  // message with no surface at all, which is worse.
  const activityStarted = process.env.LIVE_ACTIVITY_PUSH_TO_START !== "0" && !liveActivityDelivered && !suppressLiveActivity
    ? await startLiveActivityIfNeeded(room_id, {
        roomName: room_name || title,
        alertTitle: sender_display_name || title,
        detail: body,
        actions,
      }).then((r) => r?.accepted === true).catch(() => false)
    : false;

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
        // Silent when you're reading on another device, and when this device is
        // the active one but already showing this very room.
        if (active.some((c) => c.pushkey !== pushkey) ||
            active.some((c) => c.pushkey === pushkey && c.roomId === room_id)) return;
        // Suppress the alert on the phone that is showing the Live Activity: it
        // already got an alerting Live Activity push (sound + haptic) for this
        // same message, so a banner here is a second buzz. Web Push (other
        // devices, e.g. desktop) is untouched — this only skips the native
        // iOS alert, and only when the Live Activity push actually landed.
        // Only a *delivered update* suppresses the banner — an activity that
        // was already running proved itself by registering its token. A start
        // is never trusted for this; see the note above.
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
            // Lets the notification service extension rewrite this into a
            // communication notification (round room avatar, à la Messages).
            // Harmless if no service extension is installed — iOS just delivers
            // the alert as-is.
            "mutable-content": 1,
            ...(counts?.unread != null ? { badge: counts.unread } : {}),
          },
          roomId: room_id,
          // Proxy (https) URL of the room avatar for the service extension to
          // download and hang on the communication-notification intent. null
          // when the room has no resolvable avatar — the extension falls back to
          // the plain alert.
          avatarUrl,
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

      // Same rule as the native branch above: quiet on every other device while
      // you're reading, and quiet here for the room already on screen.
      if (active.some((c) => c.pushkey !== pushkey) ||
          active.some((c) => c.pushkey === pushkey && c.roomId === room_id)) return;

      const icon = avatarUrl;
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

  // Leaves a trace of which branch ran for this message — see recordNotify.
  await recordNotify({
    roomId: room_id,
    liveActivityDelivered,
    activityStarted,
    devices: devices.length,
    // The alert is suppressed when a Live Activity carried the message instead.
    alertSuppressed: liveActivityDelivered,
    activeClients: active.length,
    activeNonNative,
  });

  // Matrix spec requires returning rejected pushkeys so the homeserver unregisters them
  res.status(200).json({ rejected });
}
