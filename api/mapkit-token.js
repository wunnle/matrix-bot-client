/**
 * Short-lived MapKit JS tokens for the location picker.
 * GET /api/mapkit-token → { token }
 *
 * MapKit asks for a fresh one through its authorizationCallback whenever the
 * last has expired, so these live half an hour. No origin claim: the native
 * app's WebView runs at capacitor://localhost, which a domain-locked token
 * would refuse. Gated by authorized() instead, so only the owner mints them.
 *
 * Env: MAPKIT_KEY_ID, MAPKIT_PRIVATE_KEY (the .p8 with MapKit JS enabled),
 * MAPKIT_TEAM_ID (falls back to APNS_TEAM_ID — same team).
 * Auth: x-intent-secret header. See _auth.js.
 */
import crypto from "node:crypto";
import { authorized } from "./_auth.js";
import { cors } from "./_cors.js";

const TTL_S = 30 * 60;

export function mapkitToken(ttlS = TTL_S) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = { alg: "ES256", kid: process.env.MAPKIT_KEY_ID, typ: "JWT" };
  const claims = { iss: process.env.MAPKIT_TEAM_ID || process.env.APNS_TEAM_ID, iat: now, exp: now + ttlS };
  const unsigned = `${b64(header)}.${b64(claims)}`;
  const key = process.env.MAPKIT_PRIVATE_KEY.replace(/\\n/g, "\n");
  const sig = crypto
    .sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${unsigned}.${sig}`;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await authorized(req))) return res.status(403).json({ error: "forbidden" });
  if (!process.env.MAPKIT_KEY_ID || !process.env.MAPKIT_PRIVATE_KEY) {
    return res.status(503).json({ error: "mapkit not configured" });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ token: mapkitToken() });
}
