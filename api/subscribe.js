import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const subscription = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: "invalid subscription" });

  await kv.set("push_subscription", JSON.stringify(subscription));
  res.status(201).json({ ok: true });
}
