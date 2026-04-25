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

  const { title, body } = req.body;
  if (!title) return res.status(400).json({ error: "missing title" });

  const { blobs } = await list({ prefix: "push_subscription.json" });
  if (!blobs.length) return res.status(404).json({ error: "no subscription" });

  const response = await fetch(blobs[0].url);
  const subscription = await response.json();

  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body: body || "" }));
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
