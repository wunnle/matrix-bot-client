/**
 * Live Activities as a channel: bots start, update and end them explicitly
 * through /api/activity; the app registers each activity's push token through
 * /api/live-activity. This module is the registry and the APNs side of both.
 *
 * Registry: Matrix account data `com.construct.activities`, deliberately its
 * own document. `com.construct.live_activity` is rewritten by recordNotify on
 * every message, and sharing it would reintroduce last-write-wins losses.
 *
 *   { activities: { "<activityId>": {
 *       roomId, token|null, startedAt, updatedAt, endsAt (ms),
 *       lastTs (s, last aps timestamp), content (last content-state),
 *       pending (content-state that arrived before the token did, or null) } },
 *     lastStart: { … } }
 *
 * The content-state shape is a contract with ConstructActivityAttributes in
 * the app (AppDelegate.swift) and the widget; ActivityKit drops a push that
 * doesn't decode without a word, so keys here must match the Swift exactly.
 *
 * Read-modify-write without compare-and-swap, like the rest of this app's
 * account data. Writers are a bot's calls and the app's token registration,
 * which rarely coincide; a lost write costs one stale entry, which reconcile
 * and expiry clean up.
 */
import { apnsSendWithFallback, apnsConfigured, LIVE_ACTIVITY_TOPIC } from "./_apns.js";

const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix-client.matrix.org";
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const REGISTRY_TYPE = "com.construct.activities";
/** Push-to-start tokens are registered by the app under the older document. */
const LEGACY_TYPE = "com.construct.live_activity";

/** iOS shows at most a handful per app; three keeps the lock screen readable. */
export const MAX_LIVE = 3;
export const DEFAULT_TTL_S = 60 * 60;
/** iOS ends an activity after 8 hours regardless. */
export const MAX_TTL_S = 8 * 60 * 60;
/** Apple budgets Live Activity pushes; a bot looping on updates must not burn it. */
export const MIN_UPDATE_INTERVAL_MS = 2000;
/** A start whose token never registered: the activity never appeared. */
const UNREGISTERED_GRACE_MS = 10 * 60 * 1000;
/** Ended activities stay on the lock screen this long unless told otherwise. */
export const DEFAULT_DISMISS_S = 10 * 60;

const TONES = new Set(["neutral", "success", "warning", "error"]);
const ALERTS = new Set(["none", "quiet", "loud"]);
export const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export class ActivityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ── Account data ─────────────────────────────────────────────────────── */

let userIdPromise = null;
function userId() {
  if (!userIdPromise) {
    userIdPromise = fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`whoami failed: ${r.status}`);
        return (await r.json()).user_id;
      })
      .catch((err) => {
        userIdPromise = null;
        throw err;
      });
  }
  return userIdPromise;
}

async function accountDataUrl(type) {
  return `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(await userId())}/account_data/${type}`;
}

async function readDoc(type) {
  const r = await fetch(await accountDataUrl(type), { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`read ${type} failed: ${r.status}`);
  return (await r.json()) ?? {};
}

async function writeDoc(type, value) {
  const r = await fetch(await accountDataUrl(type), {
    method: "PUT",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`write ${type} failed: ${r.status}`);
}

export async function readRegistry() {
  const doc = await readDoc(REGISTRY_TYPE);
  return { ...doc, activities: doc.activities ?? {} };
}

export const writeRegistry = (reg) => writeDoc(REGISTRY_TYPE, reg);

/* ── Content-state ────────────────────────────────────────────────────── */

function str(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ActivityError(400, `missing ${field}`);
    return undefined;
  }
  if (typeof value !== "string") throw new ActivityError(400, `${field} must be a string`);
  const v = value.trim();
  if (required && !v) throw new ActivityError(400, `missing ${field}`);
  return v.slice(0, max);
}

function parseActions(actions) {
  if (actions === undefined) return undefined;
  if (!Array.isArray(actions)) throw new ActivityError(400, "actions must be an array");
  if (actions.length > 3) throw new ActivityError(400, "at most 3 actions");
  return actions.map((a, i) => {
    const label = str(typeof a === "string" ? a : a?.label, `actions[${i}].label`, 24, { required: true });
    const send = str(typeof a === "string" ? undefined : a?.send, `actions[${i}].send`, 500) || label;
    return { label, send };
  });
}

/** What an update merges over when the entry has no content yet: an activity
    the app started itself only registers a token, never its content. */
const EMPTY_CONTENT = { title: "", body: "", tone: "neutral", actions: [] };

/**
 * `until` → unix seconds for the countdown. Accepts unix seconds or an ISO
 * date string; must be in the future and within the 8-hour ceiling. Pure.
 */
export function parseUntil(value, nowMs = Date.now()) {
  const ms = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new ActivityError(400, "until must be unix seconds or an ISO date");
  if (ms <= nowMs) throw new ActivityError(400, "until is in the past");
  if (ms > nowMs + MAX_TTL_S * 1000) throw new ActivityError(400, "until is more than 8 hours away");
  return Math.floor(ms / 1000);
}

/**
 * The content-state for a start (no `prev`) or an update (merged over `prev`).
 * Pure apart from reading the clock for `until`; throws ActivityError(400) on
 * bad input.
 *
 * `endsAt` is the countdown the widget draws, so it is only set when a bot
 * asks for one (`until`); `null` clears it. It is not the activity's lifetime:
 * that's the TTL, which only drives stale-date and cleanup. Sending the TTL as
 * endsAt put a meaningless "59:41" on every card.
 */
export function buildContentState(input, prev = null, { roomId, roomName, nowMs = Date.now() }) {
  const title = str(input.title, "title", 80, { required: !prev });
  const body = str(input.body, "body", 300);
  const step = str(input.step, "step", 12);
  let tone;
  if (input.tone !== undefined) {
    if (!TONES.has(input.tone)) throw new ActivityError(400, `tone must be one of ${[...TONES].join(", ")}`);
    tone = input.tone;
  }
  let progress;
  if (input.progress !== undefined && input.progress !== null) {
    const p = Number(input.progress);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new ActivityError(400, "progress must be between 0 and 1");
    progress = p;
  }
  const actions = parseActions(input.actions);

  const base = prev ?? EMPTY_CONTENT;
  const next = {
    ...base,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(tone !== undefined ? { tone } : {}),
    ...(actions !== undefined ? { actions } : {}),
    roomId,
    roomName,
  };
  const endsAt = input.until === undefined || input.until === null ? undefined : parseUntil(input.until, nowMs);
  // Optional keys are dropped rather than sent as null: Swift's defaults cover
  // a missing key, and an explicit null clears them on purpose.
  for (const [key, value, raw] of [
    ["progress", progress, input.progress],
    ["step", step, input.step],
    ["endsAt", endsAt, input.until],
  ]) {
    if (raw === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  // A countdown left over from an earlier state is dropped once it has run
  // out, so a later update doesn't resend a finished timer.
  if (next.endsAt !== undefined && next.endsAt * 1000 <= nowMs) delete next.endsAt;
  return next;
}

/** The activity's lifetime (ms) so it covers any countdown: a countdown past
    the lifetime would be cut off by stale-date and cleanup. An explicit ttl
    that's too short is refused rather than silently stretched. Pure. */
export function lifetimeFor(content, endsAtMs, { explicitTtl, nowMs = Date.now() }) {
  if (content.endsAt === undefined) return endsAtMs;
  const needed = content.endsAt * 1000 + 10 * 60 * 1000;
  if (needed <= endsAtMs) return endsAtMs;
  if (explicitTtl) throw new ActivityError(400, "until is after the activity's ttl; raise ttl or drop it");
  return Math.min(needed, nowMs + MAX_TTL_S * 1000);
}

export function parseAlert(value, fallback) {
  if (value === undefined) return fallback;
  if (!ALERTS.has(value)) throw new ActivityError(400, `alert must be one of ${[...ALERTS].join(", ")}`);
  return value;
}

export function parseTtl(value) {
  if (value === undefined) return DEFAULT_TTL_S;
  const t = Number(value);
  if (!Number.isFinite(t) || t <= 0) throw new ActivityError(400, "ttl must be a positive number of seconds");
  return Math.min(Math.floor(t), MAX_TTL_S);
}

/** aps `alert` block, or undefined for a silent push. */
function alertBlock(level, content) {
  if (level === "none") return undefined;
  return {
    title: content.title,
    body: (content.body || content.roomName || "").slice(0, 150),
    ...(level === "loud" ? { sound: "default" } : {}),
  };
}

/** ActivityKit ignores a push whose timestamp isn't newer than the last. */
function nextTs(entry) {
  return Math.max(Math.floor(Date.now() / 1000), (entry?.lastTs ?? 0) + 1);
}

/* ── Room names ───────────────────────────────────────────────────────── */

async function roomName(roomId) {
  try {
    const r = await fetch(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
    );
    if (r.ok) return ((await r.json())?.name || "").slice(0, 60) || roomId;
  } catch {}
  return roomId;
}

/* ── APNs ─────────────────────────────────────────────────────────────── */

function summarize(r) {
  return { status: r.status, env: r.env, apnsId: r.apnsId ?? null, body: (r.body || "").slice(0, 200) };
}

const deadToken = (r) => r.status === 410 || (r.status === 400 && (r.body || "").includes("BadDeviceToken"));

/** `lifetimeMs` becomes the stale-date: iOS dims the card when the activity's
    TTL runs out, whether or not it shows a countdown. */
async function pushUpdate(entry, content, alert, lifetimeMs = entry.endsAt) {
  const ts = nextTs(entry);
  const payload = {
    aps: {
      timestamp: ts,
      event: "update",
      "content-state": content,
      "stale-date": Math.floor(lifetimeMs / 1000),
      ...(alert ? { alert } : {}),
    },
  };
  const r = await apnsSendWithFallback(entry.token, payload, {
    topic: LIVE_ACTIVITY_TOPIC,
    pushType: "liveactivity",
    // Priority 5 is what Apple asks for non-urgent updates and is cheaper
    // against the budget; anything that alerts is urgent by definition.
    priority: alert ? 10 : 5,
  });
  return { r, ts };
}

async function pushEnd(entry, content, dismissInS) {
  const ts = nextTs(entry);
  const payload = {
    aps: {
      timestamp: ts,
      event: "end",
      "content-state": content,
      "dismissal-date": ts + Math.max(0, dismissInS),
    },
  };
  const r = await apnsSendWithFallback(entry.token, payload, {
    topic: LIVE_ACTIVITY_TOPIC,
    pushType: "liveactivity",
    priority: 10,
  });
  return { r, ts };
}

/** Push-to-start tokens, newest first. The app rotates them and each device
    keeps a trail of older ones; the newest is the one it's listening on. */
async function pushToStartTokens() {
  const doc = await readDoc(LEGACY_TYPE);
  return Object.entries(doc.pushToStart ?? {})
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([t]) => t);
}

async function pushStart(id, content, alert, lifetimeMs) {
  const tokens = await pushToStartTokens();
  if (!tokens.length) throw new ActivityError(409, "no push-to-start token registered; open the app once");
  const ts = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: ts,
      event: "start",
      "attributes-type": "ConstructActivityAttributes",
      attributes: { activityId: id },
      "content-state": content,
      "stale-date": Math.floor(lifetimeMs / 1000),
      // Required: iOS silently drops a start push without an alert.
      alert,
    },
  };
  const results = [];
  for (const token of tokens) {
    const r = await apnsSendWithFallback(token, payload, {
      topic: LIVE_ACTIVITY_TOPIC,
      pushType: "liveactivity",
      priority: 10,
    });
    results.push(summarize(r));
    // One accepted start is the whole job; trying the next token too would
    // create a duplicate activity, not reach another device.
    if (r.status === 200) break;
  }
  return { ts, results, accepted: results.some((r) => r.status === 200) };
}

/* ── Housekeeping ─────────────────────────────────────────────────────── */

/** Entries past their TTL, and starts that never registered a token. Pure. */
export function expiredIds(activities, now = Date.now()) {
  return Object.entries(activities)
    .filter(([, e]) => now >= (e.endsAt ?? 0) || (!e.token && now - (e.startedAt ?? 0) > UNREGISTERED_GRACE_MS))
    .map(([id]) => id);
}

/** Which entries to end so a new start fits under MAX_LIVE: least recently
    updated first. Pure. */
export function evictionIds(activities, max = MAX_LIVE) {
  const ids = Object.entries(activities).sort(([, a], [, b]) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0)).map(([id]) => id);
  return ids.slice(0, Math.max(0, ids.length - (max - 1)));
}

/** End and remove the given entries. Mutates `reg`. */
async function endEntries(reg, ids, dismissInS = 0) {
  for (const id of ids) {
    const entry = reg.activities[id];
    if (entry?.token && entry.content) {
      await pushEnd(entry, entry.content, dismissInS).catch(() => {});
    }
    delete reg.activities[id];
  }
}

async function prune(reg) {
  const ids = expiredIds(reg.activities);
  await endEntries(reg, ids, 0);
  return ids;
}

/* ── Operations ───────────────────────────────────────────────────────── */

/**
 * The bot-facing operation behind POST /api/activity. Starts `id` if it isn't
 * running, updates it if it is, ends it when `end` is set.
 */
export async function upsertActivity(input) {
  if (!apnsConfigured()) throw new ActivityError(500, "APNs not configured");
  const id = input.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new ActivityError(400, "id must be 1-64 characters of letters, digits, _ . : -");
  }

  const reg = await readRegistry();
  const pruned = await prune(reg);
  const entry = reg.activities[id];
  const now = Date.now();

  if (input.end) {
    if (!entry) {
      if (pruned.length) await writeRegistry(reg);
      return { ok: true, id, action: "none", reason: "not running" };
    }
    const dismiss = input.dismissIn === undefined ? DEFAULT_DISMISS_S : Math.max(0, Number(input.dismissIn) || 0);
    // An ended card shows its final state; a countdown only if one is given.
    const content = buildContentState(
      { ...input, until: input.until ?? null },
      entry.content ?? EMPTY_CONTENT,
      { roomId: entry.roomId, roomName: entry.content?.roomName ?? entry.roomId, nowMs: now },
    );
    let apns = null;
    if (entry.token) apns = summarize((await pushEnd(entry, content, dismiss)).r);
    delete reg.activities[id];
    await writeRegistry(reg);
    return { ok: true, id, action: "ended", apns, ...(entry.token ? {} : { note: "token never registered; removed without a push" }) };
  }

  if (entry) {
    if (now - (entry.updatedAt ?? 0) < MIN_UPDATE_INTERVAL_MS) {
      throw new ActivityError(429, `updates to one activity are limited to one per ${MIN_UPDATE_INTERVAL_MS / 1000}s`);
    }
    const content = buildContentState(input, entry.content ?? EMPTY_CONTENT, { roomId: entry.roomId, roomName: entry.content?.roomName ?? entry.roomId, nowMs: now });
    const endsAtMs = lifetimeFor(
      content,
      input.ttl !== undefined ? now + parseTtl(input.ttl) * 1000 : entry.endsAt,
      { explicitTtl: input.ttl !== undefined, nowMs: now },
    );
    const alert = alertBlock(parseAlert(input.alert, "none"), content);

    if (!entry.token) {
      // Started, but the app hasn't reported the activity's token yet. Keep
      // the update; registerToken() pushes it the moment the token arrives.
      reg.activities[id] = { ...entry, content, pending: content, endsAt: endsAtMs, updatedAt: now };
      await writeRegistry(reg);
      return { ok: true, id, action: "queued", reason: "waiting for the activity's push token" };
    }

    const { r, ts } = await pushUpdate(entry, content, alert, endsAtMs);
    if (deadToken(r)) {
      delete reg.activities[id];
      await writeRegistry(reg);
      return { ok: false, id, action: "gone", reason: "activity was dismissed on the device", apns: summarize(r) };
    }
    reg.activities[id] = { ...entry, content, pending: null, endsAt: endsAtMs, updatedAt: now, lastTs: ts };
    await writeRegistry(reg);
    return { ok: r.status === 200, id, action: "updated", apns: summarize(r) };
  }

  // Start.
  const room = str(input.room, "room", 255, { required: true });
  if (!room.startsWith("!")) throw new ActivityError(400, "room must be a Matrix room id (!…)");
  const content = buildContentState(input, null, {
    roomId: room,
    roomName: str(input.roomName, "roomName", 60) || (await roomName(room)),
    nowMs: now,
  });
  const endsAtMs = lifetimeFor(content, now + parseTtl(input.ttl) * 1000, {
    explicitTtl: input.ttl !== undefined,
    nowMs: now,
  });
  // A start must alert or iOS drops it; "none" becomes quiet.
  const level = parseAlert(input.alert, "quiet");
  const alert = alertBlock(level === "none" ? "quiet" : level, content);

  const evicted = Object.keys(reg.activities).length >= MAX_LIVE ? evictionIds(reg.activities) : [];
  await endEntries(reg, evicted, 0);

  let start;
  try {
    start = await pushStart(id, content, alert, endsAtMs);
  } catch (err) {
    // Evictions and pruning above already pushed their ends; record them
    // even though this start didn't happen.
    await writeRegistry(reg).catch(() => {});
    throw err;
  }
  reg.lastStart = { id, at: now, accepted: start.accepted, results: start.results };
  if (start.accepted) {
    reg.activities[id] = {
      roomId: room,
      token: null,
      startedAt: now,
      updatedAt: now,
      endsAt: endsAtMs,
      lastTs: start.ts,
      content,
      pending: null,
    };
  }
  await writeRegistry(reg);
  return {
    ok: start.accepted,
    id,
    action: start.accepted ? "started" : "failed",
    apns: start.results,
    ...(evicted.length ? { evicted } : {}),
  };
}

/** The app reporting an activity's update token (it rotates). Creates the
    entry for activities the app started itself (the debug overlay), and
    delivers any update that arrived before the token did. */
export async function registerToken(activityId, token) {
  const reg = await readRegistry();
  const now = Date.now();
  const entry = reg.activities[activityId] ?? {
    roomId: "",
    startedAt: now,
    updatedAt: now,
    endsAt: now + DEFAULT_TTL_S * 1000,
    lastTs: 0,
    content: null,
    pending: null,
  };
  let next = { ...entry, token };
  let delivered = null;
  if (entry.pending && apnsConfigured()) {
    const { r, ts } = await pushUpdate(next, entry.pending, undefined);
    delivered = summarize(r);
    if (r.status === 200) next = { ...next, pending: null, lastTs: ts };
  }
  reg.activities[activityId] = next;
  await writeRegistry(reg);
  return { ok: true, pendingDelivered: delivered };
}

/** The app saying an activity ended on the device. */
export async function forgetActivity(activityId) {
  const reg = await readRegistry();
  if (!reg.activities[activityId]) return { ok: true, removed: 0 };
  delete reg.activities[activityId];
  await writeRegistry(reg);
  return { ok: true, removed: 1 };
}

/** The app listing every activity still alive on the device; everything else
    goes. Entries started in the last minute are kept even when unlisted: a
    push-to-start can still be on its way to the device. */
export async function reconcile(liveIds) {
  const keep = new Set(liveIds);
  const reg = await readRegistry();
  const now = Date.now();
  const drop = Object.entries(reg.activities)
    .filter(([id, e]) => !keep.has(id) && now - (e.startedAt ?? 0) > 60_000)
    .map(([id]) => id);
  for (const id of drop) delete reg.activities[id];
  if (drop.length) await writeRegistry(reg);
  return { ok: true, removed: drop.length };
}

/** For diagnostics and `construct-activity list`. No tokens. */
export async function listActivities() {
  const reg = await readRegistry();
  const now = Date.now();
  return {
    activities: Object.entries(reg.activities).map(([id, e]) => ({
      id,
      roomId: e.roomId,
      title: e.content?.title ?? null,
      registered: !!e.token,
      pending: !!e.pending,
      ageS: Math.round((now - (e.startedAt ?? now)) / 1000),
      endsInS: Math.round(((e.endsAt ?? now) - now) / 1000),
    })),
    lastStart: reg.lastStart ?? null,
  };
}
