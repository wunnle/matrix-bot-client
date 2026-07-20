/**
 * Live Activity push-token registry.
 *
 * ActivityKit mints a push token per Activity (not per device, and it rotates),
 * so the app registers one when it starts an activity and clears it when the
 * activity ends. matrix-push.js reads these to push updates into a running
 * Live Activity — which is the only way to update one while the app is
 * suspended.
 *
 * State is encoded in the blob path:
 *   live_activity/{sha256(roomId)}/{apnsToken}_{ts}
 * so matrix-push.js only needs list() — no blob content fetch.
 *
 * Auth: x-intent-secret header — never the URL or body.
 */
import { put, list, del } from "@vercel/blob";
import crypto from "node:crypto";

/** Room IDs contain `!` and `:`; percent-encoding them puts a literal `%` in the
    blob pathname, which the store rejects. Hash instead — deterministic, and
    path-safe by construction. */
function roomKey(roomId) {
  return crypto.createHash("sha256").update(roomId).digest("hex").slice(0, 32);
}

const SECRET = process.env.INTENT_SECRET;
const PREFIX = "live_activity/";
// Activities are short-lived; a token outliving this is stale and its pushes
// would be rejected by APNs anyway.
const TTL_MS = 60 * 60 * 1000;

export default async function handler(req, res) {
  if (!SECRET) return res.status(500).json({ error: "server not configured" });
  if (req.headers["x-intent-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  // Diagnostic: how many tokens are registered for a room. Counts only — token
  // values are credentials. Without this there is no way to tell a token that
  // never registered from a push that failed to deliver.
  if (req.method === "GET") {
    const roomId = req.query?.roomId;
    if (!roomId) return res.status(400).json({ error: "missing roomId" });
    const tokens = await liveActivityTokens(roomId);
    return res.status(200).json({ roomId, count: tokens.length });
  }

  if (req.method !== "POST") return res.status(405).end();

  const { roomId, token, action } = req.body || {};
  if (!roomId) return res.status(400).json({ error: "missing roomId" });

  const key = roomKey(roomId);

  // "end" clears every token for the room — the activity is over, and a stale
  // token would keep the gateway pushing into a dismissed activity.
  if (action === "end") {
    try {
      const { blobs } = await list({ prefix: `${PREFIX}${key}/` });
      if (blobs.length) await del(blobs.map((b) => b.url));
    } catch {}
    return res.status(200).json({ ok: true });
  }

  if (!token) return res.status(400).json({ error: "missing token" });

  try {
    // Drop expired entries and any prior token for this room, so a restarted
    // activity doesn't leave the previous one being pushed to.
    const { blobs } = await list({ prefix: `${PREFIX}${key}/` });
    const now = Date.now();
    const stale = blobs.filter((b) => {
      const ts = Number(b.pathname.split("_").pop());
      return !Number.isFinite(ts) || now - ts > TTL_MS;
    });
    if (stale.length) await del(stale.map((b) => b.url));

    await put(`${PREFIX}${key}/${token}_${Date.now()}`, "1", {
      access: "public",
      addRandomSuffix: false,
      contentType: "text/plain",
    });
  } catch (err) {
    // Report the reason: a silently-swallowed blob failure here is
    // indistinguishable from a client that never registered.
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }

  res.status(200).json({ ok: true });
}

/** Drop every token for a room. Called after an "end" push is delivered. */
export async function clearTokens(roomId) {
  try {
    const { blobs } = await list({ prefix: `${PREFIX}${roomKey(roomId)}/` });
    if (blobs.length) await del(blobs.map((b) => b.url));
  } catch {}
}

/** Live tokens for a room, newest first. Used by matrix-push.js. */
export async function liveActivityTokens(roomId) {
  try {
    const { blobs } = await list({ prefix: `${PREFIX}${roomKey(roomId)}/` });
    const now = Date.now();
    return blobs
      .map((b) => {
        const name = b.pathname.split("/").pop() || "";
        const sep = name.lastIndexOf("_");
        return { token: name.slice(0, sep), ts: Number(name.slice(sep + 1)) };
      })
      .filter((t) => t.token && Number.isFinite(t.ts) && now - t.ts <= TTL_MS)
      .sort((a, b) => b.ts - a.ts)
      .map((t) => t.token);
  } catch {
    return [];
  }
}
