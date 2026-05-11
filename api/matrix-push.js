/**
 * Matrix HTTP Push Gateway — /_matrix/push/v1/notify
 * https://spec.matrix.org/v1.9/push-gateway-api/
 *
 * Receives push notifications from matrix.org and delivers them as Web Push
 * to the subscription stored under push_subscriptions/{hash}.json in Vercel Blob.
 */
import { list } from "@vercel/blob";
import webpush from "web-push";
import { createHash } from "crypto";

async function getActiveRooms() {
  // State is encoded in blob paths: active_rooms/{deviceId}/{roomId}_{ts}
  // list() hits the Blob storage API directly — no CDN, always fresh.
  try {
    const { blobs } = await list({ prefix: "active_rooms/" });
    const now = Date.now();
    const TTL_MS = 5 * 60 * 1000;
    const active = new Set();
    for (const blob of blobs) {
      // path: active_rooms/{deviceId}/{encodedRoomId}_{ts}
      const parts = blob.pathname.split("/");
      if (parts.length < 3) continue;
      const filename = parts[parts.length - 1];
      const lastUnderscore = filename.lastIndexOf("_");
      if (lastUnderscore === -1) continue;
      const ts = parseInt(filename.slice(lastUnderscore + 1), 10);
      if (now - ts > TTL_MS) continue;
      const roomId = decodeURIComponent(filename.slice(0, lastUnderscore));
      active.add(roomId);
    }
    return active;
  } catch {
    return new Set();
  }
}

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
  const body = content?.body
    ? content.body.slice(0, 100)
    : sender_display_name
    ? `New message from ${sender_display_name}`
    : "New message";

  const rejected = [];
  const activeRooms = await getActiveRooms();

  await Promise.all(
    devices.map(async (device) => {
      const pushkey = device.pushkey;
      if (!pushkey) return;

      const id = createHash("sha256").update(pushkey).digest("hex").slice(0, 16);
      const { blobs } = await list({ prefix: `push_subscriptions/${id}.json` });
      if (!blobs.length) {
        rejected.push(pushkey);
        return;
      }

      // Skip if any client has this room open and focused
      if (activeRooms.has(room_id)) return;

      const response = await fetch(blobs[0].url);
      const subscription = await response.json();

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
