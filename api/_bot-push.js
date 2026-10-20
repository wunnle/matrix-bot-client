/**
 * Notifications for encrypted rooms, sent by the bot that wrote the message.
 *
 *   POST /api/matrix-push?from=bot
 *   x-intent-secret: <CONSTRUCT_INTENT_SECRET>
 *   { room_id, event_id, content, room_name? }
 *
 * Served by matrix-push.js rather than as its own route: the project is at
 * twelve routed functions, Vercel Hobby's ceiling.
 *
 * In a megolm room matrix.org has only ciphertext, so the push it sends the
 * gateway (matrix-push.js) has no text to show. The agent bot does have it —
 * it just encrypted it — so after sending it hands the plaintext content here
 * and this delivers it exactly as the homeserver path would (_push.js: same
 * formatting, [[action]] chips, md field, presence muting, dedupe).
 *
 * Which devices: the pushers the owner's account has registered on matrix.org
 * pointing at this gateway, read live with MATRIX_ACCESS_TOKEN. That list is
 * what the homeserver itself uses, so there is no second registry to drift,
 * and a pusher a device retired is gone here too.
 *
 * No double notifications: the event is looked up on the homeserver first,
 * and only an m.room.encrypted one is delivered — a plaintext event already
 * got its push from matrix.org. The homeserver's push for the encrypted event
 * still arrives, and matrix-push.js turns it into a badge-only update.
 *
 * The plaintext passes through this function and APNs / the Web Push service,
 * as every notification's text does; it is not logged or stored.
 */
import { authorized, owner } from "./_auth.js";
import { deliver, roomStateEvent } from "./_push.js";

const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix-client.matrix.org";
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
/** The gateway URL Construct registers its pushers with (usePushNotifications.ts). */
const GATEWAY_URL = process.env.PUSH_GATEWAY_URL || "https://construct.kafagoz.com/_matrix/push/v1/notify";

const api = (path, init = {}) =>
  fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });

/** The owner's pushers that deliver through this gateway, as `devices`. */
async function gatewayDevices() {
  const r = await api("/pushers");
  if (!r.ok) throw new Error(`pushers: HTTP ${r.status}`);
  const { pushers = [] } = await r.json();
  return pushers
    .filter((p) => p.kind === "http" && p.pushkey && p.data?.url === GATEWAY_URL)
    .map((p) => ({ app_id: p.app_id, pushkey: p.pushkey }));
}

/**
 * True when the owner's push rules say this room shouldn't notify: the master
 * switch, a room "mute" (an override rule named after the room), or a room
 * rule without `notify` ("mentions only" — a bot message isn't a mention).
 * The homeserver would have applied these itself for a plaintext event.
 * Fails open: an unreadable rule set notifies.
 */
export function mutedByRules(global, roomId) {
  const notifies = (rule) => (rule.actions ?? []).includes("notify");
  if (global?.override?.some((r) => r.rule_id === ".m.rule.master" && r.enabled)) return true;
  const roomOverride = global?.override?.find((r) => r.rule_id === roomId && r.enabled);
  if (roomOverride) return !notifies(roomOverride);
  const roomRule = global?.room?.find((r) => r.rule_id === roomId && r.enabled);
  if (roomRule) return !notifies(roomRule);
  return false;
}

async function roomMuted(roomId) {
  try {
    const r = await api("/pushrules/");
    if (!r.ok) return false;
    return mutedByRules((await r.json())?.global, roomId);
  } catch {
    return false;
  }
}

export async function botPushHandler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: "unauthorized" });
  if (!ACCESS_TOKEN) return res.status(500).json({ error: "server not configured" });

  const { room_id, event_id, content, room_name } = req.body ?? {};
  if (typeof room_id !== "string" || typeof event_id !== "string" || typeof content?.body !== "string") {
    return res.status(400).json({ error: "room_id, event_id and content.body are required" });
  }

  // The event as the homeserver has it: proves it exists, says who sent it,
  // and whether matrix.org could read it (and so already pushed it).
  const evRes = await api(`/rooms/${encodeURIComponent(room_id)}/event/${encodeURIComponent(event_id)}`);
  if (!evRes.ok) return res.status(404).json({ error: `event not found (${evRes.status})` });
  const event = await evRes.json();
  if (event.type !== "m.room.encrypted") {
    return res.status(200).json({ sent: false, reason: "not encrypted; the homeserver pushes it" });
  }
  const me = await owner().catch(() => null);
  if (!me || event.sender === me) return res.status(200).json({ sent: false, reason: "own message" });

  const [muted, devices, nameEvent, member] = await Promise.all([
    roomMuted(room_id),
    gatewayDevices().catch(() => null),
    room_name ? null : roomStateEvent(room_id, "m.room.name"),
    roomStateEvent(room_id, "m.room.member", event.sender),
  ]);
  if (muted) return res.status(200).json({ sent: false, reason: "room muted" });
  if (!devices) return res.status(502).json({ error: "could not list pushers" });
  if (!devices.length) return res.status(200).json({ sent: false, reason: "no devices" });

  const result = await deliver(
    {
      room_id,
      room_name: typeof room_name === "string" && room_name ? room_name : nameEvent?.name ?? null,
      event_id,
      sender: event.sender,
      sender_display_name: member?.displayname ?? null,
      content,
      devices,
      // No counts: only the homeserver knows the unread total, and its own
      // push for this event sets the badge (matrix-push.js, deliverBadge).
    },
    { dedupeKey: `bot:${event_id}`, source: "bot" }
  );

  // The homeserver retires pushers the gateway reports dead; on this path no
  // homeserver is asking, so retire them the same way it would.
  for (const pushkey of result.rejected) {
    const d = devices.find((x) => x.pushkey === pushkey);
    await api("/pushers/set", {
      method: "POST",
      body: JSON.stringify({ kind: null, app_id: d.app_id, pushkey }),
    }).catch(() => {});
  }

  res.status(200).json({
    sent: !result.suppressed && !result.duplicate,
    ...(result.suppressed ? { reason: result.suppressed } : {}),
    ...(result.duplicate ? { reason: "duplicate" } : {}),
    devices: devices.length,
    rejected: result.rejected.length,
  });
}
