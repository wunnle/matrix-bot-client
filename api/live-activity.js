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
import { apnsSendWithFallback, LIVE_ACTIVITY_TOPIC } from "./_apns.js";

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
  if (data?.lastPush !== undefined) lastPushCache = data.lastPush;
  const rooms = data?.rooms ?? {};
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(rooms).filter(([, v]) => v?.token && now - (v.ts ?? 0) <= TTL_MS)
  );
}

let lastPushCache = null;
async function writeRooms(rooms, lastPush) {
  if (lastPush !== undefined) lastPushCache = lastPush;
  const r = await fetch(await accountDataUrl(), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rooms, lastPush: lastPushCache }),
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
          lastPush: lastPushCache,
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

  // Fire a Live Activity push at the registered token, without consuming it, so
  // payload variants can be tried against a live activity in seconds instead of
  // one round trip per hypothesis. APNs returns 200 for a push that never
  // reaches the activity, so the apns-unique-id is returned too — it's the only
  // handle Apple gives for tracing a delivery.
  if (action === "test-push") {
    const { event = "update", detail = "test push", withDismissal = false,
            priority = 10, status: stateStatus = "Reply" } = req.body;
    const rooms = await readRooms();
    const entry = rooms[roomId];
    if (!entry?.token) return res.status(200).json({ error: "no token registered for room" });

    const nowSec = Math.floor(Date.now() / 1000);
    const aps = {
      timestamp: nowSec,
      event,
      "content-state": { status: stateStatus, detail },
    };
    if (event === "end" && withDismissal) aps["dismissal-date"] = nowSec + 600;

    const r = await apnsSendWithFallback(entry.token, { aps }, {
      topic: LIVE_ACTIVITY_TOPIC,
      pushType: "liveactivity",
      priority,
    });
    return res.status(200).json({ sent: { event, priority, withDismissal }, result: r });
  }

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

/** Record what APNs said about the last Live Activity push, so a push that is
    sent but never lands can be told apart from one that was never sent. Read
    back via GET /api/live-activity. */
export async function recordPushResult(roomId, result) {
  try {
    const rooms = await readRooms();
    await writeRooms(rooms, { roomId, at: Date.now(), ...result });
  } catch {}
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
