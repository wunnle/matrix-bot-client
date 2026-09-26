/**
 * Live Activities as a notification channel for bots.
 *
 * POST /api/activity
 *   { id, room, title, body?, tone?, progress?, step?, actions?: [{label, send?}],
 *     alert?: "none"|"quiet"|"loud", ttl?, end?: true, dismissIn? }
 *   An unknown id starts an activity (room and title required), a known one
 *   updates it (only the fields given change), `end: true` ends it. A button
 *   tap posts `send` (default: the label) into `room` through /api/send-message,
 *   tagged with `com.construct.activity_id`.
 *
 * GET /api/activity — what's running, for `construct-activity list`.
 *
 * Auth: x-intent-secret — the bots' INTENT_SECRET. See _auth.js.
 * Registry and APNs logic: _activities.js.
 */
import { authorized } from "./_auth.js";
import { upsertActivity, listActivities, ActivityError } from "./_activities.js";

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(403).json({ error: "forbidden" });

  try {
    if (req.method === "GET") return res.status(200).json(await listActivities());
    if (req.method !== "POST") return res.status(405).end();
    const input = req.body && typeof req.body === "object" ? req.body : {};
    return res.status(200).json(await upsertActivity(input));
  } catch (err) {
    if (err instanceof ActivityError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
