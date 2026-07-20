/**
 * Live Activity push-token registry.
 *
 * ActivityKit mints a push token per Activity (not per device, and it rotates),
 * so the app registers one when it starts an activity and clears it when the
 * activity ends. matrix-push.js reads these to push updates into a running
 * Live Activity — which is the only way to update one while the app is
 * suspended.
 *
 * The token has to outlive the request that created it: the ask and the push
 * are separate stateless invocations, minutes apart. Storage is Matrix account
 * data rather than a blob/KV store — the homeserver is already this app's
 * source of truth and needs no separate vendor, quota, or billing. Both the
 * read and the write use MATRIX_ACCESS_TOKEN, so there is no cross-account
 * visibility question.
 *
 * Shape, under account data type `com.construct.live_activity`:
 *   { rooms: { "<roomId>": { token, ts } } }
 *
 * Auth: x-intent-secret header — never the URL or body.
 */
const SECRET = process.env.INTENT_SECRET;
const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix-client.matrix.org";
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const ACCOUNT_DATA_TYPE = "com.construct.live_activity";

// Activities are short-lived; a token outliving this is stale and its pushes
// would be rejected by APNs anyway.
const TTL_MS = 60 * 60 * 1000;

let cachedUserId = null;
async function userId() {
  if (cachedUserId) return cachedUserId;
  const r = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`whoami failed: ${r.status}`);
  const { user_id } = await r.json();
  cachedUserId = user_id;
  return user_id;
}

async function accountDataUrl() {
  return `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(await userId())}/account_data/${ACCOUNT_DATA_TYPE}`;
}

/** Current map, with expired entries dropped. `{}` when unset — a 404 here
    just means no activity has ever registered. */
async function readRooms() {
  const r = await fetch(await accountDataUrl(), {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`read account data failed: ${r.status}`);
  const data = await r.json();
  const rooms = data?.rooms ?? {};
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(rooms).filter(([, v]) => v?.token && now - (v.ts ?? 0) <= TTL_MS)
  );
}

async function writeRooms(rooms) {
  const r = await fetch(await accountDataUrl(), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rooms }),
  });
  if (!r.ok) throw new Error(`write account data failed: ${r.status}`);
}

export default async function handler(req, res) {
  if (!SECRET || !ACCESS_TOKEN) return res.status(500).json({ error: "server not configured" });
  if (req.headers["x-intent-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  // Diagnostic: how many tokens are registered for a room. Counts only — token
  // values are credentials. Without this there is no way to tell a token that
  // never registered from a push that failed to deliver.
  if (req.method === "GET") {
    try {
      const rooms = await readRooms();
      const roomId = req.query?.roomId;
      // Without a roomId, list which rooms actually hold a token. A token
      // registered under a different room id than the one being queried looks
      // identical to no registration at all.
      if (!roomId) {
        return res.status(200).json({
          rooms: Object.entries(rooms).map(([id, v]) => ({ roomId: id, ageMs: Date.now() - (v.ts ?? 0) })),
        });
      }
      return res.status(200).json({ roomId, count: rooms[roomId] ? 1 : 0 });
    } catch (err) {
      return res.status(200).json({ error: String(err?.message || err) });
    }
  }

  if (req.method !== "POST") return res.status(405).end();

  const { roomId, token, action } = req.body || {};
  if (!roomId) return res.status(400).json({ error: "missing roomId" });
  if (action !== "end" && !token) return res.status(400).json({ error: "missing token" });

  // Errors are reported, not swallowed: a silent storage failure here is
  // indistinguishable from a client that never registered, which is exactly
  // what made this hard to diagnose the first time round.
  try {
    const rooms = await readRooms();
    if (action === "end") {
      delete rooms[roomId];
    } else {
      // One activity per room: a restarted activity replaces the previous
      // token so the gateway can't push into a dead one.
      rooms[roomId] = { token, ts: Date.now() };
    }
    await writeRooms(rooms);
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }

  res.status(200).json({ ok: true });
}

/** Live tokens for a room. Used by matrix-push.js. */
export async function liveActivityTokens(roomId) {
  try {
    const rooms = await readRooms();
    const entry = rooms[roomId];
    return entry?.token ? [entry.token] : [];
  } catch {
    return [];
  }
}

/** Drop a room's token. Called after an "end" push is delivered. */
export async function clearTokens(roomId) {
  try {
    const rooms = await readRooms();
    if (!rooms[roomId]) return;
    delete rooms[roomId];
    await writeRooms(rooms);
  } catch {}
}
