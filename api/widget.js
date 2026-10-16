/**
 * Home-screen boards for the Construct widget.
 *
 * POST /api/widget
 *   { id, title?, tone?, tiles?: [{icon, value, sub?, tone?}] | null,
 *     lines?: [string] | null, room?: "!roomid" | null, clear?: true }
 *   Sets the board `id`: only the fields given change, `null` clears tiles,
 *   lines or room. `clear: true` removes the board. Tiles are the Live
 *   Activity's (SF Symbol or bundled logo, value, sub, tone), up to 4; lines up
 *   to 3. A tap on the widget opens `room`, else the app.
 *
 * GET /api/widget            — every board, for `construct-widget list`.
 * GET /api/widget?id=board   — one board, for the widget's timeline.
 *
 * Auth: x-intent-secret — the bots' INTENT_SECRET, or the owner's Matrix token,
 * which the widget reads from the App Group. See _auth.js.
 */
import { authorized } from "./_auth.js";
import { ActivityError } from "./_activities.js";
import { upsertBoard, readBoards } from "./_widgets.js";

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(403).json({ error: "forbidden" });

  try {
    if (req.method === "GET") {
      const id = typeof req.query?.id === "string" ? req.query.id : undefined;
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(await readBoards(id));
    }
    if (req.method !== "POST") return res.status(405).end();
    const input = req.body && typeof req.body === "object" ? req.body : {};
    return res.status(200).json(await upsertBoard(input));
  } catch (err) {
    if (err instanceof ActivityError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
