// Device-token sign/verify contract (BEN-378): api/_device-token.js.
import assert from "node:assert/strict";
import { deviceTokenKey, signDeviceToken, verifyDeviceToken } from "../api/_device-token.js";

const key = deviceTokenKey({ INTENT_SECRET: "s3cret" });
assert.deepEqual(key, deviceTokenKey({ CONSTRUCT_INTENT_SECRET: "s3cret" }), "Pi and Vercel derive the same key");
assert.notDeepEqual(key, Buffer.from("s3cret"), "the key is not the bot secret itself");
assert.equal(deviceTokenKey({}), null);

const now = 1_800_000_000_000;
const { token, expiresAt } = signDeviceToken(key, "@wunnle:kafagoz.com", { now });
assert.equal(verifyDeviceToken(key, token, now), "@wunnle:kafagoz.com");
assert.equal(verifyDeviceToken(key, token, expiresAt + 1), null, "expired");
assert.equal(verifyDeviceToken(deviceTokenKey({ INTENT_SECRET: "other" }), token, now), null, "wrong key");

const [p, body, sig] = token.split(".");
const forged = Buffer.from(JSON.stringify({ u: "@evil:x", iat: 0, exp: 9e9 })).toString("base64url");
assert.equal(verifyDeviceToken(key, `${p}.${forged}.${sig}`, now), null, "tampered payload");
assert.equal(verifyDeviceToken(key, `${p}.${body}.${sig.slice(0, -2)}`, now), null, "truncated sig");
assert.equal(verifyDeviceToken(key, "syt_matrix_token", now), null, "Matrix tokens fall through");
assert.equal(verifyDeviceToken(null, token, now), null);

console.log("device-token: ok");
