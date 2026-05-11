/**
 * Active room beacon — tracks which room each device currently has open.
 * PATCH { roomId, deviceId } on focus, { roomId: null, deviceId } on blur.
 * matrix-push.js reads this before delivering a push to skip rooms already in view.
 */
import { put, list } from "@vercel/blob";

const PREFIX = "active_rooms/state.json";
const TTL_MS = 5 * 60 * 1000;

async function loadState() {
  try {
    const { blobs } = await list({ prefix: PREFIX });
    if (!blobs.length) return {};
    const r = await fetch(blobs[0].url);
    return await r.json();
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== "PATCH") return res.status(405).end();

  const { roomId, deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "missing deviceId" });

  const state = await loadState();
  const now = Date.now();

  // Prune stale entries
  for (const id of Object.keys(state)) {
    if (now - state[id].ts > TTL_MS) delete state[id];
  }

  if (roomId) {
    state[deviceId] = { roomId, ts: now };
  } else {
    delete state[deviceId];
  }

  await put(PREFIX, JSON.stringify(state), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });

  res.status(200).json({ ok: true });
}
