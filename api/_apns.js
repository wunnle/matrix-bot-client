/**
 * APNs HTTP/2 sender, shared by the push gateway and the Live Activity test
 * endpoint. Token-based auth (ES256 JWT from the .p8), node builtins only.
 *
 * Env: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_TOPIC.
 *
 * Underscore prefix keeps Vercel from routing this as an endpoint.
 */
import crypto from "node:crypto";
import http2 from "node:http2";

export const APNS_BUNDLE_ID = process.env.APNS_TOPIC || "com.wunnle.construct";

/** Live Activity pushes use a distinct topic suffix and push type. */
export const LIVE_ACTIVITY_TOPIC = `${APNS_BUNDLE_ID}.push-type.liveactivity`;

export function apnsConfigured() {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_PRIVATE_KEY);
}

let apnsJwtCache = { token: null, iat: 0 };
function apnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  // Apple requires JWTs between 20 and 60 minutes old; refresh at ~45.
  if (apnsJwtCache.token && now - apnsJwtCache.iat < 2700) return apnsJwtCache.token;
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "ES256", kid: process.env.APNS_KEY_ID })}.${b64({ iss: process.env.APNS_TEAM_ID, iat: now })}`;
  const key = process.env.APNS_PRIVATE_KEY.replace(/\\n/g, "\n");
  const sig = crypto
    .sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  apnsJwtCache = { token: `${unsigned}.${sig}`, iat: now };
  return apnsJwtCache.token;
}

/** Apple reporting the token belongs to the other environment. Two spellings:
    BadDeviceToken           — production key, sandbox token
    BadEnvironmentKeyInToken — sandbox-only auth key hitting production */
export function isEnvMismatch(r) {
  return (
    (r.status === 400 && r.body.includes("BadDeviceToken")) ||
    (r.status === 403 && r.body.includes("BadEnvironmentKeyInToken"))
  );
}

export function apnsSend(host, deviceToken, payload, { topic, pushType, priority } = {}) {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`);
    client.on("error", () => resolve({ status: 0, body: "connect error" }));
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${apnsJwt()}`,
      "apns-topic": topic || APNS_BUNDLE_ID,
      "apns-push-type": pushType || "alert",
      "apns-priority": String(priority ?? 10),
    });
    let status = 0;
    let body = "";
    let apnsId = null;
    req.on("response", (headers) => {
      status = headers[":status"];
      apnsId = headers["apns-unique-id"] || headers["apns-id"] || null;
    });
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { client.close(); resolve({ status, body, apnsId }); });
    req.on("error", () => { client.close(); resolve({ status: 0, body: "stream error" }); });
    req.setTimeout(10_000, () => { req.close(); client.close(); resolve({ status: 0, body: "timeout" }); });
    req.end(JSON.stringify(payload));
  });
}

/** Send to production, falling back to sandbox on an environment mismatch.
    Returns which environment actually took it. */
export async function apnsSendWithFallback(deviceToken, payload, opts) {
  let r = await apnsSend("api.push.apple.com", deviceToken, payload, opts);
  if (isEnvMismatch(r)) {
    r = await apnsSend("api.sandbox.push.apple.com", deviceToken, payload, opts);
    return { ...r, env: "sandbox" };
  }
  return { ...r, env: "production" };
}
