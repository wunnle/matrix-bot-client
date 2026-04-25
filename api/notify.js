import { list } from "@vercel/blob";
import webpush from "web-push";

webpush.setVapidDetails(
  "mailto:sinanaksay@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const secret = process.env.NOTIFY_SECRET;
  if (secret && req.headers["x-notify-secret"] !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { title, body, roomId, icon } = req.body;
  if (!title) return res.status(400).json({ error: "missing title" });

  const { blobs } = await list({ prefix: "push_subscriptions/" });
  if (!blobs.length) return res.status(404).json({ error: "no subscriptions" });

  const payload = JSON.stringify({ title, body: body || "", roomId: roomId || null, icon: icon || null });

  const results = await Promise.allSettled(
    blobs.map(async (blob) => {
      const response = await fetch(blob.url);
      const subscription = await response.json();
      await webpush.sendNotification(subscription, payload);
    })
  );

  const failed = results.filter((r) => r.status === "rejected").length;
  res.status(200).json({ ok: true, sent: results.length - failed, failed });
}
