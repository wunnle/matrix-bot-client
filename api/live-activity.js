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
import { apnsSendWithFallback, apnsConfigured, LIVE_ACTIVITY_TOPIC } from "./_apns.js";

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

/** The whole account-data blob. `{}` when unset — a 404 here just means nothing
    has ever registered. Besides `rooms` it carries `pushToStart` (device tokens
    that let the gateway *create* an activity, see startLiveActivityIfNeeded)
    and `started` (when we last did so per room). */
async function readBlob() {
  const r = await fetch(await accountDataUrl(), {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`read account data failed: ${r.status}`);
  const data = (await r.json()) ?? {};
  if (data.lastPush !== undefined) lastPushCache = data.lastPush;
  return data;
}

async function writeBlob(next) {
  const r = await fetch(await accountDataUrl(), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(next),
  });
  if (!r.ok) throw new Error(`write account data failed: ${r.status}`);
}

/** Live per-room update tokens, with expired entries dropped. */
async function readRooms() {
  const data = await readBlob();
  const rooms = data.rooms ?? {};
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(rooms).filter(([, v]) => v?.token && now - (v.ts ?? 0) <= TTL_MS)
  );
}

let lastPushCache = null;
/** Read-modify-write: `rooms` is only one field of the blob, and blindly
    replacing the document would drop the push-to-start registrations. */
async function writeRooms(rooms, lastPush) {
  if (lastPush !== undefined) lastPushCache = lastPush;
  const blob = await readBlob();
  await writeBlob({ ...blob, rooms, lastPush: lastPushCache });
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
        // Counts only — token values are credentials. pushToStart tells a
        // device that never registered apart from one whose start push failed.
        const blob = await readBlob();
        return res.status(200).json({
          rooms: Object.entries(rooms).map(([id, v]) => ({ roomId: id, ageMs: Date.now() - (v.ts ?? 0) })),
          pushToStartTokens: Object.keys(blob.pushToStart ?? {}).length,
          started: Object.entries(blob.started ?? {}).map(([id, ts]) => ({ roomId: id, ageMs: Date.now() - ts })),
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

  // Push-to-start token (iOS 17.2+). Unlike the others this is per *device*,
  // not per room — it's what lets the gateway create an activity for a room the
  // app has never opened. Registered before any room exists, so it must be
  // handled ahead of the roomId check.
  if (action === "push-to-start") {
    if (!token) return res.status(400).json({ error: "missing token" });
    try {
      const blob = await readBlob();
      const pushToStart = { ...(blob.pushToStart ?? {}), [token]: Date.now() };
      // These rotate; drop ones that haven't been re-registered in a month so
      // the list can't grow without bound across reinstalls.
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const [t, ts] of Object.entries(pushToStart)) {
        if (ts < cutoff) delete pushToStart[t];
      }
      await writeBlob({ ...blob, pushToStart });
    } catch (err) {
      return res.status(200).json({ ok: false, error: String(err?.message || err) });
    }
    return res.status(200).json({ ok: true });
  }

  if (!roomId) return res.status(400).json({ error: "missing roomId" });

  // Fire a Live Activity push at the registered token, without consuming it, so
  // payload variants can be tried against a live activity in seconds instead of
  // one round trip per hypothesis. APNs returns 200 for a push that never
  // reaches the activity, so the apns-unique-id is returned too — it's the only
  // handle Apple gives for tracing a delivery.
  if (action === "test-push") {
    const { event = "update", detail = "test push", withDismissal = false,
            priority = 10, status: stateStatus = "Reply", alert = false,
            question, actions = [], roomId: stateRoomId } = req.body;
    const rooms = await readRooms();
    const entry = rooms[roomId];
    if (!entry?.token) return res.status(200).json({ error: "no token registered for room" });

    const nowSec = Math.floor(Date.now() / 1000);
    const aps = {
      timestamp: nowSec,
      event,
      "content-state": {
        status: stateStatus,
        question: question ?? entry.question ?? "",
        detail,
        roomId: stateRoomId ?? roomId,
        actions: Array.isArray(actions) ? actions.slice(0, 3) : [],
      },
    };
    if (alert) aps.alert = { title: "Bender", body: detail.slice(0, 150), sound: "default" };
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
      // token so the gateway can't push into a dead one. The question is kept
      // so the gateway can echo it (faded) alongside the reply.
      rooms[roomId] = { token, ts: Date.now(), question: req.body.question || "" };
    }
    await writeRooms(rooms);
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }

  res.status(200).json({ ok: true });
}

/** Don't re-create an activity for the same room on every message: a push-start
    is fire-and-forget (APNs 200 says nothing about whether ActivityKit started
    one), so without a cooldown a chatty room would stack duplicates. */
const START_COOLDOWN_MS = 15 * 60 * 1000;

/** Create a Live Activity for a room that doesn't have one, using the device's
    push-to-start token (iOS 17.2+). This is what extends Live Activities to
    every room rather than only the ones started from inside the app.

    Deliberately silent — no `alert` block — and the caller still sends its
    normal notification. We cannot tell from here whether the activity actually
    started (old iOS, Live Activities disabled, token stale), and suppressing
    the banner on an unconfirmed start is exactly how messages go missing. */
export async function startLiveActivityIfNeeded(roomId, { roomName, detail, question = "", actions = [] }) {
  if (!apnsConfigured()) return { skipped: "apns-not-configured" };
  let blob;
  try {
    blob = await readBlob();
  } catch (err) {
    return { skipped: "read-failed", error: String(err?.message || err) };
  }

  const existing = blob.rooms?.[roomId];
  if (existing?.token && Date.now() - (existing.ts ?? 0) <= TTL_MS) {
    return { skipped: "already-running" };
  }
  const started = { ...(blob.started ?? {}) };
  if (Date.now() - (started[roomId] ?? 0) < START_COOLDOWN_MS) return { skipped: "cooldown" };

  const tokens = Object.keys(blob.pushToStart ?? {});
  if (!tokens.length) return { skipped: "no-push-to-start-token" };

  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: nowSec,
      event: "start",
      "stale-date": nowSec + 900,
      // Must match the Swift type name and its stored properties exactly, or
      // ActivityKit drops the push without a word.
      "attributes-type": "ConstructActivityAttributes",
      attributes: { roomName: roomName || "Construct" },
      "content-state": {
        status: "Reply",
        question: question.slice(0, 120),
        detail: (detail || "").slice(0, 300),
        roomId,
        actions: actions.slice(0, 3),
      },
    },
  };

  const results = [];
  const live = { ...(blob.pushToStart ?? {}) };
  for (const t of tokens) {
    const r = await apnsSendWithFallback(t, payload, {
      topic: LIVE_ACTIVITY_TOPIC,
      pushType: "liveactivity",
      priority: 10,
    });
    results.push({ status: r.status, env: r.env, apnsId: r.apnsId });
    // A device that reinstalled or disabled activities reports the token dead.
    if (r.status === 410 || (r.status === 400 && (r.body || "").includes("BadDeviceToken"))) {
      delete live[t];
    }
  }

  started[roomId] = Date.now();
  try {
    await writeBlob({ ...blob, pushToStart: live, started });
  } catch {}
  return { sent: results.length, results };
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

/** Live token + stored question for a room. Used by matrix-push.js. */
export async function liveActivityEntry(roomId) {
  try {
    const rooms = await readRooms();
    const entry = rooms[roomId];
    return entry?.token ? { token: entry.token, question: entry.question || "" } : null;
  } catch {
    return null;
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
