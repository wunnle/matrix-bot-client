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

  const title = room_name || "Hermes";
  const body = content?.body
    ? content.body.slice(0, 100)
    : sender_display_name
    ? `New message from ${sender_display_name}`
    : "New message";

  const rejected = [];

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

      const response = await fetch(blobs[0].url);
      const subscription = await response.json();

      const payload = JSON.stringify({
        title,
        body,
        roomId: room_id || null,
        icon: null,
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
