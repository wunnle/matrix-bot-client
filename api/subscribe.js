import { put } from "@vercel/blob";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const subscription = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: "invalid subscription" });

  await put("push_subscription.json", JSON.stringify(subscription), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
  res.status(201).json({ ok: true });
}
