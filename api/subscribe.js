import { put } from "@vercel/blob";
import { createHash } from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { deviceId, ...subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: "invalid subscription" });

  const id = createHash("sha256").update(subscription.endpoint).digest("hex").slice(0, 16);
  await put(`push_subscriptions/${id}.json`, JSON.stringify({ ...subscription, deviceId }), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
  res.status(201).json({ ok: true });
}
