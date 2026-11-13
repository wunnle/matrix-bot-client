#!/usr/bin/env node
/**
 * Construct's /api on the Pi, for the self-hosted kafagoz.com account (BEN-379).
 *
 * Vercel's copy of these routes keeps its state in matrix.org account data and
 * can't reach the tailnet-only homeserver. This runs the same api/*.js handlers
 * against the local Tuwunel instead, so Live Activity cards, button taps,
 * shares and widgets work without matrix.org. State is stored as account data
 * on the account behind MATRIX_ACCESS_TOKEN (@wunnle:kafagoz.com).
 *
 * Reachable only on the tailnet, mounted beside the homeserver:
 *   tailscale serve --bg --https=6443 --set-path=/_construct http://127.0.0.1:8781
 * The client uses <homeserver>/_construct as its API base (src/lib/apiUrl.ts).
 * Bots on the Pi call http://127.0.0.1:8781/api/... directly.
 *
 *   /api/<route>     the Vercel handler of the same name (ROUTES below)
 *   /device-token    mints a device token (BEN-378, see api/_device-token.js)
 *
 * Config, read before the handlers load (they read process.env at import):
 *   ~/.hermes/.env                   CONSTRUCT_INTENT_SECRET → INTENT_SECRET
 *   ~/projects/selfhost-matrix/accounts/wunnle.json   → MATRIX_ACCESS_TOKEN
 *   ~/.config/construct-api/env      APNS_KEY_ID, APNS_TEAM_ID,
 *                                    APNS_PRIVATE_KEY, APNS_TOPIC; any override
 *                                    (chmod 600, never in git)
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOME = homedir();
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "api");

function envFile(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* optional */ }
  return out;
}

function accountToken(path) {
  try { return JSON.parse(readFileSync(path, "utf8")).access_token; } catch { return undefined; }
}

const hermes = envFile(`${HOME}/.hermes/.env`);
const local = envFile(`${HOME}/.config/construct-api/env`);
const defaults = {
  MATRIX_HOMESERVER: "http://127.0.0.1:6167",
  MATRIX_ACCESS_TOKEN: accountToken(`${HOME}/projects/selfhost-matrix/accounts/wunnle.json`),
  INTENT_SECRET: hermes.CONSTRUCT_INTENT_SECRET,
  MEDIA_ALLOWED_SERVERS: "kafagoz.com",
  DEVICE_TOKEN_USERS: "@wunnle:kafagoz.com",
  // Notification avatars (api/_push.js) link here, so the phone fetches them
  // from the Pi over the tailnet rather than from Vercel.
  MEDIA_BASE_URL: "https://bender.tale-bellatrix.ts.net:6443/_construct/api/media",
  // The agent bot posts in every agent room; titles go by room for it.
  AGENT_BOT_IDS: "@bender:kafagoz.com",
  PORT: "8781",
};
for (const [k, v] of Object.entries({ ...defaults, ...local })) {
  if (v !== undefined && process.env[k] === undefined) process.env[k] = v;
}
for (const k of ["MATRIX_ACCESS_TOKEN", "INTENT_SECRET"]) {
  if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }
}
if (!process.env.APNS_PRIVATE_KEY) console.warn("APNS_* not set: cards can't be pushed until ~/.config/construct-api/env has them");

/** Routes served here. The rest (maps, Linear, Discord, frame checks) need
    keys that live only in Vercel and don't touch the homeserver. */
const ROUTES = new Set([
  "activity", "live-activity", "send-message", "send-file", "wait-reply", "widget", "media",
]);

/**
 * The push gateway for Tuwunel's pushers (BEN-384), the same matrix-push.js
 * Vercel runs, so presence muting, dedupe, clear-on-read and avatars read the
 * local account. Tuwunel reaches it over the tailnet:
 *   https://bender.tale-bellatrix.ts.net:6443/_construct/_matrix/push/v1/notify
 * which its ip_range_denylist allows for the Pi's own tailnet /32 only
 * (~/projects/selfhost-matrix/tuwunel.toml).
 *
 * The spec gives the gateway no authentication, so only devices that are
 * really @wunnle's pushers to this gateway are delivered to; anything else on
 * the tailnet can't push to an arbitrary token through it. Listed live from
 * Tuwunel, cached briefly.
 */
const NOTIFY_PATH = "/_matrix/push/v1/notify";
let pusherCache = { keys: null, at: 0 };
async function ownPushkeys() {
  if (pusherCache.keys && Date.now() - pusherCache.at < 60_000) return pusherCache.keys;
  const r = await fetch(`${process.env.MATRIX_HOMESERVER.replace(/\/$/, "")}/_matrix/client/v3/pushers`, {
    headers: { Authorization: `Bearer ${process.env.MATRIX_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`pushers: HTTP ${r.status}`);
  const { pushers = [] } = await r.json();
  const keys = new Set(
    pushers.filter((p) => p.kind === "http" && p.data?.url?.endsWith(`/_construct${NOTIFY_PATH}`)).map((p) => p.pushkey)
  );
  pusherCache = { keys, at: Date.now() };
  return keys;
}

async function notify(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  req.body = await parseBody(req);
  // The bot's encrypted-room path (?from=bot) authenticates itself.
  if (req.query?.from !== "bot") {
    const n = req.body?.notification;
    if (!n) return res.status(400).json({ rejected: [] });
    const devices = n.devices ?? [];
    let keys = await ownPushkeys();
    // A pusher registered seconds ago may not be in the cache yet.
    if (devices.some((d) => !keys.has(d.pushkey))) { pusherCache.at = 0; keys = await ownPushkeys(); }
    const dropped = devices.length - devices.filter((d) => keys.has(d.pushkey)).length;
    if (dropped) console.log(`notify: dropped ${dropped} unknown pushkey(s)`);
    n.devices = devices.filter((d) => keys.has(d.pushkey));
    // Never report an unknown key as rejected: it isn't ours to unregister.
    if (!n.devices.length) return res.status(200).json({ rejected: [] });
  }
  const { fn } = await handlerFor("matrix-push");
  await fn(req, res);
}

const { deviceTokenKey, signDeviceToken } = await import("../api/_device-token.js");
const KEY = deviceTokenKey(process.env);
const USERS = new Set(process.env.DEVICE_TOKEN_USERS.split(",").map((s) => s.trim()).filter(Boolean));
const HOMESERVER = process.env.MATRIX_HOMESERVER.replace(/\/$/, "");
const ORIGINS = new Set(["https://construct.kafagoz.com", "capacitor://localhost"]);

/** Vercel's Node helpers, the part of them these handlers use. */
function vercelize(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (body === undefined || body === null) return res.end();
    if (Buffer.isBuffer(body) || typeof body === "string") return res.end(body);
    return res.json(body);
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function parseBody(req) {
  const type = (req.headers["content-type"] || "").split(";")[0].trim();
  const raw = await readBody(req);
  if (!raw.length) return undefined;
  if (type === "application/json") {
    try { return JSON.parse(raw.toString("utf8")); } catch { return undefined; }
  }
  if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
  if (type.startsWith("text/")) return raw.toString("utf8");
  return raw;
}

const handlers = new Map();
async function handlerFor(route) {
  if (!handlers.has(route)) {
    const mod = await import(join(API_DIR, `${route}.js`));
    handlers.set(route, { fn: mod.default, rawBody: mod.config?.api?.bodyParser === false });
  }
  return handlers.get(route);
}

async function deviceToken(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const m = (req.headers.authorization || "").match(/^Bearer\s+(\S+)$/);
  if (!m) return res.status(401).json({ error: "missing token" });
  let userId = null;
  try {
    const r = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${m[1]}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) userId = (await r.json())?.user_id ?? null;
    else if (r.status >= 500) return res.status(502).json({ error: "homeserver unavailable" });
  } catch {
    return res.status(502).json({ error: "homeserver unavailable" });
  }
  if (!userId) return res.status(401).json({ error: "unknown token" });
  if (!USERS.has(userId)) {
    console.log(`device-token: refused ${userId}`);
    return res.status(403).json({ error: "forbidden" });
  }
  const { token, expiresAt } = signDeviceToken(KEY, userId);
  console.log(`device-token: minted for ${userId}, expires ${new Date(expiresAt).toISOString()}`);
  return res.status(200).json({ token, expiresAt, userId });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  // tailscale serve may or may not strip the /_construct mount.
  const path = url.pathname.replace(/^\/_construct(?=\/)/, "");
  vercelize(req, res, url);
  // One line per request, no credentials: the method, path, status and, for
  // a JSON body, its action and activityId. Handlers often answer 200 with
  // {ok:false, error} (see live-activity.js), so log that error too.
  const t0 = Date.now();
  const json = res.json;
  let replyError = null;
  res.json = (obj) => {
    if (obj && obj.ok === false && obj.error) replyError = String(obj.error).slice(0, 200);
    return json(obj);
  };
  res.on("finish", () => {
    if (req.method === "OPTIONS") return;
    const b = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {};
    const tags = [b.action ?? b.op, b.activityId ?? b.id].filter((v) => typeof v === "string").join(" ");
    console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms${tags ? ` [${tags}]` : ""}${replyError ? ` error: ${replyError}` : ""}`);
  });
  try {
    if (path === "/device-token") return await deviceToken(req, res);
    if (path === NOTIFY_PATH) return await notify(req, res);
    const route = path.match(/^\/api\/([a-z-]+)$/)?.[1];
    if (!route || !ROUTES.has(route)) return res.status(404).json({ error: "not found" });
    const { fn, rawBody } = await handlerFor(route);
    if (!rawBody) req.body = await parseBody(req);
    await fn(req, res);
    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error(`${req.method} ${path}:`, err?.stack || err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
    else res.end();
  }
});

server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`construct-api on 127.0.0.1:${process.env.PORT}`));
