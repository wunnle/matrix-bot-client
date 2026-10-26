/**
 * Notification delivery shared by the two ways a message reaches the phone:
 *
 *   • matrix-push.js — the homeserver's push (Matrix push gateway API). Works
 *     for unencrypted rooms only: for a megolm event matrix.org has no
 *     plaintext, so its push carries no content.body.
 *   • _bot-push.js — the agent bot announcing its own message in an encrypted
 *     room, with the plaintext it just encrypted.
 *
 * Both hand `deliver` the same notification shape (the push gateway API's), so
 * formatting, presence muting, dedupe and the APNs/Web Push fan-out are one
 * code path. Underscore prefix keeps Vercel from routing this as an endpoint.
 */
import webpush from "web-push";
import { apnsSend, apnsConfigured, isEnvMismatch } from "./_apns.js";
import { recordNotify, activeClients, seenEventBefore } from "./live-activity.js";
import { signedMediaUrl } from "./_media-sig.js";

const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix-client.matrix.org";
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
// The claudebot/codexbot account (scripts/claude-code-bot.mjs). It speaks in
// every agent room under one display name, so its pushes are titled by room.
export const AGENT_BOT_IDS = new Set(["@bender-2:matrix.org"]);

// Room avatars are resolved live from the homeserver — the account's own token
// is a member of every room it receives pushes for. Cached in-memory so warm
// invocations don't re-query matrix.org for every message; avatars change rarely.
const avatarCache = new Map(); // roomId -> { mxc, ts }
const AVATAR_TTL_MS = 10 * 60 * 1000;

export async function roomStateEvent(roomId, type, stateKey = "") {
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

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return;
  webpush.setVapidDetails(
    "mailto:sinanaksay@gmail.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  vapidReady = true;
}

/* Bender writes markdown into `body`; notifications are plain text everywhere
   (APNs and Web Push both), so "**9-4**" would render literally. Strip the
   common markers rather than ship the syntax to the lock screen.

   Deliberately does NOT touch `_underscores_`: bender talks about code, and
   stripping those would mangle snake_case identifiers. Asterisk italics are
   only stripped when they aren't adjacent to word characters, for the same
   reason. */
export function stripMarkdown(text) {
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
   parseActions (src/components/ChatView.tsx) so the notification can render the
   same one-tap buttons: pull the labels out and strip the markers from the text.
   [[label]] / [[button]] are the doc-example placeholders and aren't real CTAs. */
export function parseActions(text) {
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

export function parseWebPushKey(pushkey) {
  try {
    const sub = JSON.parse(pushkey);
    return sub?.endpoint ? sub : null;
  } catch {
    return null;
  }
}

// Tool progress / thinking message — never notifies.
const TOOL_PROGRESS_LINE = /^(?:\*\s*)?\S\S?\s+\w[\w./-]*(?::\s+".{0,80}"(?:\s+\(×\d+\))?|\.\.\.)\s*$/u;

/** Why this content must not notify, or null when it should. */
export function suppressReason(content) {
  if (!content?.body) return "no body";
  // Machine message — a component announcing something, not a person talking.
  // A file watcher reporting that a note changed must not light up the lock
  // screen. It is still in the room, styled quietly, for whenever the app is
  // opened.
  if (content["com.construct.machine"]) return "machine";
  if (content.body.split("\n").filter((l) => l.trim()).every((l) => TOOL_PROGRESS_LINE.test(l.trim()))) {
    return "thinking";
  }
  return null;
}

/** The APNs alert payload for a message. Pure, so it can be tested. */
export function apnsPayloadFor({ room_id, room_name, content, sender, sender_display_name, counts }, avatarUrl) {
  const title = room_name || "Hermes";
  // Strip before truncating, so the cut can't land mid-marker and leave a
  // dangling "**".
  //
  // iOS collapses this to a few lines and reveals the rest on long-press, so
  // the limit only needs to respect the APNs 4KB payload ceiling — cutting at
  // 100 meant expanding a notification showed nothing extra.
  const { text: body, actions } = parseActions(stripMarkdown(content.body).slice(0, 1200));
  // Sender as the title reads better than the room on iOS; the room becomes
  // the subtitle. Falls back to the web-push title when the notification
  // carries no sender. Agent rooms are the exception: every one of them posts
  // as the same bot account, so the room name is what tells them apart.
  const senderTitle = AGENT_BOT_IDS.has(sender) ? null : sender_display_name;
  return {
    aps: {
      alert: {
        title: senderTitle || title,
        // Only when it adds something: in a one-bot room the sender and the
        // room are both "Bender", which rendered the name twice.
        ...(senderTitle && room_name && room_name !== senderTitle ? { subtitle: room_name } : {}),
        body,
      },
      sound: "default",
      "thread-id": room_id,
      // Respects Focus. Breaking through it is for the Live Activity channel,
      // where a bot asks for it explicitly.
      "interruption-level": "active",
      // Enables the inline Reply action registered in AppDelegate.swift.
      category: "MESSAGE",
      // Lets the notification service extension rewrite this into a
      // communication notification (round room avatar, à la Messages).
      // Harmless if no service extension is installed — iOS just delivers the
      // alert as-is.
      "mutable-content": 1,
      ...(counts?.unread != null ? { badge: counts.unread } : {}),
    },
    roomId: room_id,
    // Proxy (https) URL of the room avatar for the service extension to
    // download and hang on the communication-notification intent. null when
    // the room has no resolvable avatar — the extension falls back to the
    // plain alert.
    avatarUrl,
    // Original markdown for the notification content extension to render on
    // long-press, with the [[CTA]] markers stripped (the extension draws those
    // as buttons instead). aps.alert.body stays stripped for the collapsed
    // view, which is plain text only. Both capped well inside the 4KB APNs
    // payload ceiling.
    md: parseActions(content.body.slice(0, 1200)).text,
    // Quick-reply chips for the content extension to render as one-tap
    // buttons (long-press the notification). Same labels as the Live
    // Activity's; only present when bender suggested any.
    ...(actions.length ? { actions: actions.slice(0, 3) } : {}),
    sender: sender_display_name || null,
  };
}

/** Web Push payload: the service worker draws title/body itself. */
export function webPushPayloadFor({ room_id, room_name, content, counts }, avatarUrl) {
  const { text: body } = parseActions(stripMarkdown(content.body).slice(0, 1200));
  return {
    title: room_name || "Hermes",
    body,
    roomId: room_id || null,
    icon: avatarUrl,
    unread: counts?.unread ?? null,
  };
}

/**
 * Fans one message out to `devices` (`[{ pushkey }]`): APNs for device tokens,
 * Web Push for subscription JSON. Returns `{ rejected, duplicate?, suppressed? }`
 * — `rejected` are pushkeys the push services said are dead.
 *
 * `dedupeKey` names this delivery for the re-delivery check; it defaults to
 * the event id. The bot path prefixes it, so its record and the homeserver's
 * can never be mistaken for each other.
 */
export async function deliver(notification, { dedupeKey = notification.event_id, source = "homeserver" } = {}) {
  const { room_id, content, event_id, sender, devices = [] } = notification;
  const reason = suppressReason(content);
  if (!room_id || reason) return { rejected: [], suppressed: reason ?? "no room" };

  const rejected = [];
  // Counted so the trace can say a notification was skipped because the device
  // was already showing the room.
  let presenceSkipped = 0;
  const startedAt = Date.now();

  // Two independent reads from the homeserver: who is in the foreground, and
  // the room avatar. Started together and awaited at their use sites.
  //
  // Safe to start before the duplicate check below: both are pure reads, and
  // each swallows its own errors, so an early return leaves nothing rejecting
  // unhandled.
  const activePromise = activeClients(75_000);
  const avatarPromise = resolveRoomAvatarMxc(room_id, sender);

  // The homeserver re-delivers an event it didn't get a timely 200 for, and
  // this handler makes several sequential round-trips before answering — so a
  // slow run comes back as the same event twice and notifies twice. Recognise
  // the repeat and acknowledge it without acting again.
  if (await seenEventBefore(dedupeKey, 5 * 60 * 1000)) {
    return { rejected: [], duplicate: true };
  }

  // Which clients are in the foreground, and which room each is showing.
  // Native: quiet for the room on its screen. Web: quiet for every room while
  // visible, since the app toasts other rooms itself. Across devices, only the
  // room you're actively chatting in elsewhere is quiet (see
  // chattingElsewhere) — an open PWA on the laptop used to silence the phone
  // completely.
  //
  // Empty on any error, so an unreadable heartbeat notifies rather than mutes.
  const active = (await activePromise).filter((c) => c.visible);
  const nativePushkeys = new Set(
    devices.map((d) => d.pushkey).filter((k) => k && !parseWebPushKey(k))
  );
  const isNativeClient = (c) => c.native || nativePushkeys.has(c.pushkey);
  const showingRoom = (pushkey) =>
    active.some((c) => c.pushkey === pushkey && c.roomId === room_id);
  const inForeground = (pushkey) => active.some((c) => c.pushkey === pushkey);
  // This room is open on another device that had keyboard/pointer input in
  // the last 2 minutes: you're chatting there, so don't buzz this one. The
  // input check is what keeps a tab left open on the laptop from muting the
  // phone indefinitely.
  const ENGAGED_MS = 2 * 60 * 1000;
  const chattingElsewhere = (pushkey) =>
    active.some(
      (c) =>
        c.pushkey !== pushkey &&
        c.roomId === room_id &&
        c.lastInputAt != null &&
        startedAt - c.lastInputAt < ENGAGED_MS
    );
  // A native client that hasn't registered its APNs token yet can't be matched
  // to its pushkey. It is assumed to be the phone, so the room on its screen
  // stays quiet during the seconds between app launch and registration.
  const unregisteredNativeHere = active.some(
    (c) => !c.pushkey && isNativeClient(c) && c.roomId === room_id
  );

  // Shared by the APNs payload (service extension) and the Web Push icon.
  const avatarUrl = signedMediaUrl(await avatarPromise);

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
        if (showingRoom(pushkey) || unregisteredNativeHere || chattingElsewhere(pushkey)) {
          presenceSkipped += 1;
          return;
        }
        const apnsPayload = apnsPayloadFor(notification, avatarUrl);
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

      // Skipped here rather than in the service worker: on iOS a push that
      // shows nothing counts as silent, and Safari revokes the subscription
      // for those. Not sending it at all is safe.
      if (inForeground(pushkey) || chattingElsewhere(pushkey)) {
        presenceSkipped += 1;
        return;
      }

      try {
        ensureVapid();
        await webpush.sendNotification(subscription, JSON.stringify(webPushPayloadFor(notification, avatarUrl)));
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
    eventId: event_id ?? null,
    source,
    // How long the handler took: the homeserver retries when this runs long,
    // which is what duplicate deliveries look like from the device.
    ms: Date.now() - startedAt,
    devices: devices.length,
    activeClients: active.length,
    presenceSkipped,
  });

  return { rejected };
}

/**
 * Badge-only update for the native app, from a homeserver push that has
 * counts but no readable content — an encrypted event. The alert itself comes
 * from the bot (_bot-push.js), which can't know the unread count, so the two
 * halves arrive separately: an alert without `badge` leaves the badge alone,
 * and this sets it. Web Push gets nothing: a push that shows nothing counts as
 * silent there, and Safari revokes subscriptions for those.
 */
export async function deliverBadge({ counts, devices = [] }) {
  if (counts?.unread == null || !apnsConfigured()) return { rejected: [] };
  const rejected = [];
  await Promise.all(
    devices.map(async ({ pushkey }) => {
      if (!pushkey || parseWebPushKey(pushkey)) return;
      const payload = { aps: { badge: counts.unread } };
      const opts = { priority: 5 };
      let r = await apnsSend("api.push.apple.com", pushkey, payload, opts);
      if (isEnvMismatch(r)) r = await apnsSend("api.sandbox.push.apple.com", pushkey, payload, opts);
      if (r.status === 410 || (r.status === 400 && r.body.includes("BadDeviceToken"))) rejected.push(pushkey);
    })
  );
  return { rejected };
}
