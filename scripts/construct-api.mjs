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
  "activity", "live-activity", "send-message", "send-file", "wait-reply", "widget",
]);

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
