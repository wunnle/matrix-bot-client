/**
 * Read-only relay to Discord's REST API, for the Pi's Discord digest.
 *
 * The Pi can't reach discord.com at all (Turkey blocks it: the TLS handshake
 * is reset), so the collector on the Pi asks this function to make the call
 * for it. All the logic stays on the Pi; this forwards one GET at a time and
 * hands Discord's answer back untouched, 429s included, so the caller does its
 * own rate-limit waiting instead of burning function time here.
 *
 *   GET /api/discord?path=/channels/123/messages&after=456&limit=100
 *   x-intent-secret: <CONSTRUCT_INTENT_SECRET>
 *   x-discord-token: <bot token>
 *
 * The bot token travels with each request, so it lives only in the Pi's
 * ~/.hermes/.env (DISCORD_DIGEST_BOT_KEY); DISCORD_BOT_TOKEN in Vercel's env
 * is the fallback. Only the read endpoints below are forwarded.
 */
import { authorized } from "./_auth.js";

const API = "https://discord.com/api/v10";
const ID = "\\d{15,22}";
const ALLOWED = [
  `^/users/@me$`,
  `^/guilds/${ID}/channels$`,
  `^/guilds/${ID}/roles$`,
  `^/guilds/${ID}/members/${ID}$`,
  `^/guilds/${ID}/threads/active$`,
  `^/channels/${ID}$`,
  `^/channels/${ID}/messages$`,
  `^/channels/${ID}/messages/${ID}$`,
  // Who reacted with one emoji (URL-encoded): Sinan's ✅/👀 acks.
  `^/channels/${ID}/messages/${ID}/reactions/[^/]{1,80}$`,
  `^/channels/${ID}/threads/archived/public$`,
  `^/channels/${ID}/users/@me/threads/archived/private$`,
].map((p) => new RegExp(p));
const QUERY_KEYS = ["after", "before", "around", "limit"];

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!(await authorized(req))) return res.status(401).json({ error: "unauthorized" });

  const path = typeof req.query.path === "string" ? req.query.path : "";
  if (!ALLOWED.some((re) => re.test(path))) {
    return res.status(400).json({ error: "path not allowed" });
  }
  const token = req.headers["x-discord-token"] || process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(400).json({ error: "no discord token" });

  const url = new URL(API + path);
  for (const key of QUERY_KEYS) {
    const value = req.query[key];
    if (typeof value === "string" && /^[\w.:-]{1,40}$/.test(value)) url.searchParams.set(key, value);
  }

  try {
    const upstream = await fetch(url, {
      headers: { Authorization: `Bot ${token}`, "User-Agent": "ConstructDigest (https://construct.kafagoz.com, 1)" },
      signal: AbortSignal.timeout(20000),
    });
    const body = await upstream.text();
    for (const h of ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset-after", "x-ratelimit-bucket"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
