/**
 * Active room beacon — tracks which room each device currently has open.
 * State is encoded in the blob path: active_rooms/{deviceId}/{roomId}
 * so matrix-push.js only needs list() — no blob content fetch needed.
 */
import { put, list, del } from "@vercel/blob";

const PREFIX = "active_rooms/";
const TTL_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { blobs } = await list({ prefix: PREFIX }).catch(() => ({ blobs: [] }));
    return res.status(200).json({ blobs: blobs.map((b) => ({ pathname: b.pathname, url: b.url })) });
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
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  }

  res.status(200).json({ ok: true });
}
