#!/usr/bin/env node
/**
 * Mints device tokens for Construct clients signed in on the tailnet-only
 * kafagoz.com homeserver (BEN-378). Vercel can't reach that server to check a
 * Matrix token, so the client asks here instead. This service checks the token
 * with the local homeserver and, for an allowed user, returns a token Vercel
 * verifies by itself (format and key in api/_device-token.js).
 *
 *   POST /device-token   Authorization: Bearer <Matrix access token>
 *     → 200 { token, expiresAt (ms), userId }
 *     → 401 the homeserver rejected the token, 403 the user isn't allowed
 *
 * Reachable only on the tailnet, mounted beside the homeserver:
 *   tailscale serve --bg --https=6443 --set-path=/_construct http://127.0.0.1:8781
 * so the client finds it at <its homeserver URL>/_construct/device-token.
 *
 * Env (from ~/.hermes/.env, then the process environment):
 *   CONSTRUCT_INTENT_SECRET  required; the signing key is derived from it
 *   DEVICE_TOKEN_KEY         optional override, must match Vercel's
 *   DEVICE_TOKEN_USERS       comma-separated allowlist (default @wunnle:kafagoz.com)
 *   DEVICE_TOKEN_HOMESERVER  default http://127.0.0.1:6167
 *   DEVICE_TOKEN_PORT        default 8781
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { deviceTokenKey, signDeviceToken } from "../api/_device-token.js";

function loadEnvFile(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* missing file: rely on the process env */ }
  return out;
}

const env = { ...loadEnvFile(`${homedir()}/.hermes/.env`), ...process.env };
const KEY = deviceTokenKey(env);
if (!KEY) {
  console.error("CONSTRUCT_INTENT_SECRET (or DEVICE_TOKEN_KEY) is not set");
  process.exit(1);
}
const USERS = new Set((env.DEVICE_TOKEN_USERS || "@wunnle:kafagoz.com").split(",").map((s) => s.trim()).filter(Boolean));
const HOMESERVER = (env.DEVICE_TOKEN_HOMESERVER || "http://127.0.0.1:6167").replace(/\/$/, "");
const PORT = Number(env.DEVICE_TOKEN_PORT || 8781);
const ORIGINS = new Set(["https://construct.kafagoz.com", "capacitor://localhost"]);

function send(req, res, status, body) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (body === undefined) return res.writeHead(status).end();
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // Tailscale may or may not strip the /_construct mount, so match the tail.
  const path = (req.url || "").split("?")[0];
  if (!path.endsWith("/device-token")) return send(req, res, 404, { error: "not found" });
  if (req.method === "OPTIONS") return send(req, res, 204);
  if (req.method !== "POST") return send(req, res, 405, { error: "method not allowed" });
  const m = (req.headers.authorization || "").match(/^Bearer\s+(\S+)$/);
  if (!m) return send(req, res, 401, { error: "missing token" });
  let userId = null;
  try {
    const r = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${m[1]}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) userId = (await r.json())?.user_id ?? null;
    else if (r.status >= 500) return send(req, res, 502, { error: "homeserver unavailable" });
  } catch {
    return send(req, res, 502, { error: "homeserver unavailable" });
  }
  if (!userId) return send(req, res, 401, { error: "unknown token" });
  if (!USERS.has(userId)) {
    console.log(`refused ${userId}`);
    return send(req, res, 403, { error: "forbidden" });
  }
  const { token, expiresAt } = signDeviceToken(KEY, userId);
  console.log(`minted for ${userId}, expires ${new Date(expiresAt).toISOString()}`);
  return send(req, res, 200, { token, expiresAt, userId });
});

server.listen(PORT, "127.0.0.1", () => console.log(`construct-device-token on 127.0.0.1:${PORT}`));
