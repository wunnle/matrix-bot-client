/**
 * Matrix HTTP Push Gateway — /_matrix/push/v1/notify
 * https://spec.matrix.org/v1.9/push-gateway-api/
 *
 * Receives push notifications from matrix.org and delivers them as Web Push
 * to the subscription stored under push_subscriptions/{hash}.json in Vercel Blob.
 */
import webpush from "web-push";
import crypto from "node:crypto";
import http2 from "node:http2";


const ROOM_AVATARS = {
  "!vjoGMHloXyNobvgGaK:matrix.org": "mxc://matrix.org/tOIBhgtMxpMQMmADcYIcprnh",
  "!PuoXYYposdTSyiwnkx:matrix.org": "mxc://matrix.org/gEzjnnOcBuppMPJoijpZAkef",
  "!mhNSsDLFdlzGIGyRgi:matrix.org": "mxc://matrix.org/pqhnMFYAoWmsukcvrjdujQdG",
  "!iEbYoSfZgfHLeSKLei:matrix.org": "mxc://matrix.org/paDQdclqzpfVYCDZiWPPMzID",
  "!tCuyENMznYGVHZQiod:matrix.org": "mxc://matrix.org/QcMeBkdMIjZGVOcwNTUkiqnI",
  "!DpRWqhWOHJAxyvjOGI:matrix.org": "mxc://matrix.org/bAFLWJDiBQExiECpdDNHVOKl",
};

function mxcToProxyUrl(mxc) {
  if (!mxc) return null;
  return `https://construct.kafagoz.com/api/media?mxc=${encodeURIComponent(mxc)}`;
}

webpush.setVapidDetails(
  "mailto:sinanaksay@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/* ── APNs (native iOS app) ─────────────────────────────────────────────
   Pushkeys that don't parse as a Web Push subscription are APNs device
   tokens. Delivery uses token-based auth (ES256 JWT from the .p8 key).
   Env: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_TOPIC. */

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

function apnsSend(host, deviceToken, payload) {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`);
    client.on("error", () => resolve({ status: 0, body: "connect error" }));
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${apnsJwt()}`,
      "apns-topic": process.env.APNS_TOPIC || "com.wunnle.construct",
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    let status = 0;
    let body = "";
    req.on("response", (headers) => { status = headers[":status"]; });
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { client.close(); resolve({ status, body }); });
    req.on("error", () => { client.close(); resolve({ status: 0, body: "stream error" }); });
    req.setTimeout(10_000, () => { req.close(); client.close(); resolve({ status: 0, body: "timeout" }); });
    req.end(JSON.stringify(payload));
  });
}

function parseWebPushKey(pushkey) {
  try {
    const sub = JSON.parse(pushkey);
    return sub?.endpoint ? sub : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { notification } = req.body || {};
  if (!notification) return res.status(400).json({ rejected: [] });

  const { room_id, room_name, content, sender_display_name, devices = [], counts } = notification;

  // Badge-only update — no actual message to show
  if (!room_id || !content?.body) return res.status(200).json({ rejected: [] });

  // Tool progress / thinking message — suppress notification
  const TOOL_PROGRESS_LINE = /^(?:\*\s*)?\S\S?\s+\w[\w./-]*(?::\s+".{0,80}"(?:\s+\(×\d+\))?|\.\.\.)\s*$/u;
  const isThinking = content.body.split('\n').filter(l => l.trim()).every(l => TOOL_PROGRESS_LINE.test(l.trim()));
  if (isThinking) return res.status(200).json({ rejected: [] });

  const title = room_name || "Hermes";
  const body = content?.body
    ? content.body.slice(0, 100)
    : sender_display_name
    ? `New message from ${sender_display_name}`
    : "New message";

  const rejected = [];

  await Promise.all(
    devices.map(async (device) => {
      const pushkey = device.pushkey;
      if (!pushkey) return;

      const subscription = parseWebPushKey(pushkey);

      if (!subscription) {
        // APNs device token (native iOS app)
        if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID || !process.env.APNS_PRIVATE_KEY) {
          return; // APNs not configured — don't reject, token may be valid later
        }
        const apnsPayload = {
          aps: {
            alert: { title, body },
            sound: "default",
            "thread-id": room_id,
            ...(counts?.unread != null ? { badge: counts.unread } : {}),
          },
          roomId: room_id,
        };
        // Dev builds register sandbox tokens; production/TestFlight builds
        // register production ones. Try production first, fall back to sandbox
        // on either mismatch Apple reports:
        //   BadDeviceToken          — production key, but a sandbox token
        //   BadEnvironmentKeyInToken — sandbox-only auth key hitting production
        let r = await apnsSend("api.push.apple.com", pushkey, apnsPayload);
        const envMismatch =
          (r.status === 400 && r.body.includes("BadDeviceToken")) ||
          (r.status === 403 && r.body.includes("BadEnvironmentKeyInToken"));
        if (envMismatch) {
          r = await apnsSend("api.sandbox.push.apple.com", pushkey, apnsPayload);
        }
        if (r.status === 410 || (r.status === 400 && r.body.includes("BadDeviceToken"))) {
          rejected.push(pushkey);
        }
        return;
      }

      const icon = mxcToProxyUrl(ROOM_AVATARS[room_id]);
      const payload = JSON.stringify({
        title,
        body,
        roomId: room_id || null,
        icon,
        unread: counts?.unread ?? null,
      });

      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          rejected.push(pushkey);
        }
      }
    })
  );

  // Matrix spec requires returning rejected pushkeys so the homeserver unregisters them
  res.status(200).json({ rejected });
}
