/**
 * Device tokens: a credential for the intent endpoints that a client on a
 * homeserver Vercel can't reach gets from the Pi (BEN-378).
 *
 * Vercel checks a client's Matrix token by asking the homeserver who it
 * belongs to. The self-hosted kafagoz.com server is tailnet-only, so that
 * check can't run for its tokens. Instead, the Pi runs
 * scripts/construct-api.mjs on the tailnet. It checks the token with
 * the local homeserver and hands back one of these, signed with a key that
 * both sides derive from INTENT_SECRET. Vercel only checks the signature and
 * the expiry. It never sees the Matrix token.
 *
 * Format: "ct1.<base64url(JSON {u, iat, exp})>.<base64url(HMAC-SHA256)>",
 * with the HMAC taken over "ct1.<payload>". exp and iat are in seconds.
 *
 * The key is HMAC(INTENT_SECRET, "construct-device-token-v1"), so no new
 * secret has to be set in Vercel. DEVICE_TOKEN_KEY overrides it on both sides
 * if the two ever need rotating separately. Rotating either one revokes every
 * device token at once, and clients mint a new one on their next launch.
 *
 * Shared by api/_auth.js (verify) and the Pi service (sign); crypto only.
 */
import crypto from "crypto";

const PREFIX = "ct1";
export const DEVICE_TOKEN_TTL_S = 30 * 24 * 60 * 60;

export function deviceTokenKey(env = process.env) {
  if (env.DEVICE_TOKEN_KEY) return Buffer.from(env.DEVICE_TOKEN_KEY);
  const secret = env.INTENT_SECRET ?? env.CONSTRUCT_INTENT_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("construct-device-token-v1").digest();
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const mac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

export function signDeviceToken(key, userId, { now = Date.now(), ttlS = DEVICE_TOKEN_TTL_S } = {}) {
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({ u: userId, iat, exp: iat + ttlS }));
  const head = `${PREFIX}.${payload}`;
  return { token: `${head}.${b64url(mac(key, head))}`, expiresAt: (iat + ttlS) * 1000 };
}

/** The user id the token was minted for, or null if it's not a valid,
    unexpired device token signed with `key`. */
export function verifyDeviceToken(key, token, now = Date.now()) {
  if (!key || typeof token !== "string" || !token.startsWith(`${PREFIX}.`)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const head = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2], "base64url");
  const want = mac(key, head);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims?.u !== "string" || typeof claims.exp !== "number") return null;
  if (claims.exp * 1000 <= now) return null;
  return claims.u;
}
