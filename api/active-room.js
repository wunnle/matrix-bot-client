/**
 * Active room beacon — tracks which room each device currently has open.
 * State is encoded in the blob path: active_rooms/{deviceId}/{roomId}
 * so matrix-push.js only needs list() — no blob content fetch needed.
 */
import { put, list, del } from "@vercel/blob";

const SECRET = process.env.INTENT_SECRET;
const PREFIX = "active_rooms/";
const TTL_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  if (!SECRET) return res.status(500).json({ error: "server not configured" });
  if (req.headers["x-intent-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  if (req.method === "GET") {
    const { blobs } = await list({ prefix: PREFIX }).catch(() => ({ blobs: [] }));
    return res.status(200).json({ blobs: blobs.map((b) => ({ pathname: b.pathname })) });
  }
  if (req.method !== "PATCH") return res.status(405).end();

  const { roomId, deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "missing deviceId" });

  // Remove any existing entry for this device
  try {
    const { blobs } = await list({ prefix: `${PREFIX}${deviceId}/` });
    if (blobs.length) await del(blobs.map((b) => b.url));
  } catch {}

  if (roomId) {
    // Encode roomId and timestamp in the path
    const ts = Date.now();
    try {
      await put(
        `${PREFIX}${deviceId}/${encodeURIComponent(roomId)}_${ts}`,
        "1",
        { access: "public", addRandomSuffix: false, contentType: "text/plain" }
      );
    } catch {
      // Blob unavailable — beacon not written, suppression and indicator degrade
      // gracefully. Push notifications still go through (getActiveRooms returns
      // empty Set on error).
    }
  }

  res.status(200).json({ ok: true });
}
