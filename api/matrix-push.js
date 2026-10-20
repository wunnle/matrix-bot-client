/**
 * Matrix HTTP Push Gateway — /_matrix/push/v1/notify
 * https://spec.matrix.org/v1.9/push-gateway-api/
 *
 * Receives push notifications from the homeserver and fans them out to each
 * pushkey it provides: Web Push subscriptions (browsers/PWA) and APNs device
 * tokens (native iOS). Live Activities are not driven from here: bots start
 * them explicitly.
 *
 * Formatting and delivery live in _push.js, shared with _bot-push.js — the
 * path that notifies for encrypted rooms, where this push has no text.
 */
import { deliver, deliverBadge } from "./_push.js";
import { botPushHandler } from "./_bot-push.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  // The bot's own notification for an encrypted room (see _bot-push.js). A
  // query flag on this route, not a route of its own: twelve functions is
  // Vercel Hobby's ceiling and the project is at it.
  if (req.query?.from === "bot") return botPushHandler(req, res);

  const { notification } = req.body || {};
  if (!notification) return res.status(400).json({ rejected: [] });

  // A megolm event: matrix.org can't read it, so there is no text to show.
  // The agent bot sends the alert itself (_bot-push.js); what only the
  // homeserver knows is the unread count, so that is all this sends.
  if (notification.type === "m.room.encrypted" && !notification.content?.body) {
    return res.status(200).json(await deliverBadge(notification));
  }

  // Badge-only update — no actual message to show
  if (!notification.room_id || !notification.content?.body) return res.status(200).json({ rejected: [] });

  const { rejected, duplicate } = await deliver(notification);
  // Matrix spec requires returning rejected pushkeys so the homeserver unregisters them
  res.status(200).json(duplicate ? { rejected, duplicate } : { rejected });
}
