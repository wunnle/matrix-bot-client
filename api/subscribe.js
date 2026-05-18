// Subscription is now stored as the pushkey in the Matrix pusher registration.
// This endpoint is kept for backwards compatibility but does nothing.
export default function handler(req, res) {
  res.status(201).json({ ok: true });
}
