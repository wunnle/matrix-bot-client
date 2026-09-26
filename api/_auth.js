/**
 * Who may call the intent endpoints (send-message, send-file, wait-reply,
 * room-intent, live-activity).
 *
 * Two kinds of caller, both presenting a credential in the `x-intent-secret`
 * header — never the URL or body:
 *
 *   • Bots on the Pi send INTENT_SECRET. It lives only in Vercel's env and, on
 *     the Pi, as CONSTRUCT_INTENT_SECRET in ~/.hermes/.env — never in the
 *     client bundle: it was
 *     once compiled in as VITE_INTENT_SECRET, which published it to anyone who
 *     loaded the site's JavaScript.
 *   • The web client and the native app send the signed-in user's own Matrix
 *     access token, accepted only if the homeserver says it belongs to the same
 *     account as MATRIX_ACCESS_TOKEN. The native side stores whatever
 *     saveIntentConfig hands it, so the header name stays the same and the
 *     Swift code needs no change.
 */
import crypto from "crypto";

const SECRET = process.env.INTENT_SECRET;
const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix-client.matrix.org";
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;

function sameSecret(presented) {
  if (!SECRET) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function whoami(token) {
  const r = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return (await r.json())?.user_id ?? null;
}

/** The account this deployment serves. The in-flight promise is cached so
    concurrent cold readers share one lookup; cleared on failure. */
let ownerPromise = null;
function owner() {
  if (!ownerPromise) {
    ownerPromise = (ACCESS_TOKEN ? whoami(ACCESS_TOKEN) : Promise.resolve(null)).then((id) => {
      if (!id) ownerPromise = null;
      return id;
    });
  }
  return ownerPromise;
}

/** Tokens already confirmed as the owner's, by hash, so a warm invocation
    doesn't ask the homeserver on every 45s heartbeat. Only successes are
    cached: a rejected token is re-checked, so a fresh login works at once. */
const confirmed = new Map(); // sha256(token) -> expiry ms
const CONFIRM_TTL_MS = 10 * 60 * 1000;

async function isOwnerToken(token) {
  const key = crypto.createHash("sha256").update(token).digest("hex");
  if ((confirmed.get(key) ?? 0) > Date.now()) return true;
  const [user, me] = await Promise.all([whoami(token).catch(() => null), owner().catch(() => null)]);
  if (!user || !me || user !== me) return false;
  confirmed.set(key, Date.now() + CONFIRM_TTL_MS);
  return true;
}

/** True when the request carries the bot secret or the owner's Matrix token. */
export async function authorized(req) {
  const presented = req.headers["x-intent-secret"];
  if (typeof presented !== "string" || !presented) return false;
  if (sameSecret(presented)) return true;
  return isOwnerToken(presented);
}
