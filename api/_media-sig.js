/**
 * Signatures for /api/media links. The proxy fetches with the owner's Matrix
 * token, so it only serves an mxc this deployment linked to itself (today the
 * push notification icon, built in _push.js). Whatever loads that icon (APNs'
 * service extension, a browser's push handler) can't send a credential, so the
 * link carries one.
 *
 * Keyed by INTENT_SECRET with a "media:" prefix, so a media signature is never
 * usable as anything else. No expiry: a link only ever unlocks the one file it
 * names, and a stable URL keeps the CDN cache for that avatar warm. With no
 * secret set, nothing verifies (fail closed).
 */
import crypto from "crypto";

export function mediaSig(mxc) {
  const secret = process.env.INTENT_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(`media:${mxc}`).digest("base64url");
}

export function validMediaSig(mxc, sig) {
  const expected = mediaSig(mxc);
  if (!expected || typeof sig !== "string") return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A signed https://construct.kafagoz.com/api/media link, or null. */
export function signedMediaUrl(mxc) {
  const sig = mxc && mediaSig(mxc);
  if (!sig) return null;
  return `https://construct.kafagoz.com/api/media?mxc=${encodeURIComponent(mxc)}&sig=${sig}`;
}
