import { useEffect } from "react";
import { setPresencePushkey } from '../lib/presence'
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

const VAPID_PUBLIC_KEY = "BHAWGVTndxe9FH-hZmiPSoLsts1NOJLIx9uwVlJIXwDYf8JeXFb1xrKvCLIR5We0djZcWlXIvwiWW2DPLQ8SHdA";
const APP_ACTIVE_CACHE = "construct-app-state";
const APP_ACTIVE_KEY = "/app-active-ts";
// SW suppresses push if timestamp is fresher than this
const ACTIVE_TTL_MS = 15_000;

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray.buffer as ArrayBuffer;
}

async function writeActiveTimestamp() {
  try {
    const cache = await caches.open(APP_ACTIVE_CACHE);
    await cache.put(APP_ACTIVE_KEY, new Response(String(Date.now())));
  } catch {}
}

async function clearActiveTimestamp() {
  try {
    const cache = await caches.open(APP_ACTIVE_CACHE);
    await cache.delete(APP_ACTIVE_KEY);
  } catch {}
}

export function usePushNotifications(enabled: boolean, onOpenRoom?: (roomId: string) => void) {
  // Write a "last active" timestamp into the Cache API while the app is visible.
  // The SW reads this on every push and suppresses if it's fresh — reliable even
  // when clients.matchAll() fails to return the open window (iOS Safari quirk).
  useEffect(() => {
    if (!enabled) return;
    if (!("caches" in window)) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        writeActiveTimestamp();
        interval = setInterval(writeActiveTimestamp, 10_000);
      } else {
        if (interval) { clearInterval(interval); interval = null; }
        clearActiveTimestamp();
      }
    };

    // Initialise for current state
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (interval) clearInterval(interval);
      clearActiveTimestamp();
    };
  }, [enabled]);

  // Forward PUSH_SUPPRESS_CHECK to dispatch matrix-push events for toast system
  useEffect(() => {
    if (!enabled) return;
    if (!("serviceWorker" in navigator)) return;

    const onServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type !== "PUSH_SUPPRESS_CHECK") return;
      const { roomId } = event.data as { roomId: string | null };
      if (roomId) {
        window.dispatchEvent(new CustomEvent("matrix-push", { detail: { roomId } }));
      }
    };

    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onServiceWorkerMessage);
  }, [enabled]);

  // Native (Capacitor): APNs token → Matrix pusher. The push gateway
  // (api/matrix-push.js) detects non-JSON pushkeys and delivers via APNs.
  useEffect(() => {
    if (!enabled) return;
    if (!Capacitor.isNativePlatform()) return;

    let cancelled = false;

    const registerNativePusher = async () => {
      try {
        let perm = await PushNotifications.checkPermissions();
        if (perm.receive === "prompt") perm = await PushNotifications.requestPermissions();
        if (perm.receive !== "granted" || cancelled) return;

        const token = await new Promise<string>((resolve, reject) => {
          PushNotifications.addListener("registration", (t) => resolve(t.value));
          PushNotifications.addListener("registrationError", (e) =>
            reject(new Error(`APNs registration failed: ${JSON.stringify(e)}`)),
          );
          PushNotifications.register().catch(reject);
        });
        if (cancelled) return;
        // Lets the gateway tell this phone apart from other devices when
        // deciding whose notifications to skip (see src/lib/presence.ts).
        setPresencePushkey(token);

        const { loadAuth } = await import("../lib/auth");
        const auth = loadAuth();
        if (!auth) return;

        await fetch(`${auth.homeserver}/_matrix/client/v3/pushers/set`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.accessToken}`,
          },
          body: JSON.stringify({
            kind: "http",
            app_id: "com.wunnle.construct.ios",
            app_display_name: "Construct",
            device_display_name: "iPhone (native)",
            pushkey: token,
            lang: "en",
            data: {
              url: "https://construct.kafagoz.com/_matrix/push/v1/notify",
              format: "event_notification",
            },
          }),
        });
        console.log("Native push pusher registered");

        // Drop this account's older pushers for the same app. APNs tokens
        // rotate — reinstall, restore, OS update — and each new one registered
        // a pusher without retiring the last, so they accumulate. Synapse runs
        // one HTTP pusher per pusher row and POSTs the gateway once for each,
        // so N stale rows means the same phone gets N notifications and N
        // separate Live Activities for a single message. The gateway's own
        // dedupe can't save it: those N requests arrive concurrently and the
        // check (live-activity.js seenEventBefore) is a read-check-write over
        // account data with no compare-and-swap, so they all read "unseen"
        // before any of them writes.
        //
        // Only tokens APNs still rejects get cleaned up on their own, via the
        // `rejected` list in api/matrix-push.js. One that a reinstall left
        // valid never goes away by itself, which is why this is explicit.
        //
        // Runs after the registration above, never before: deleting first
        // would leave a window with no pusher at all, and a failure partway
        // would end with the phone silently unsubscribed.
        try {
          const listRes = await fetch(`${auth.homeserver}/_matrix/client/v3/pushers`, {
            headers: { Authorization: `Bearer ${auth.accessToken}` },
          });
          if (listRes.ok) {
            const { pushers = [] } = await listRes.json();
            const stale = pushers.filter(
              (p: { app_id?: string; pushkey?: string }) =>
                p.app_id === "com.wunnle.construct.ios" && p.pushkey && p.pushkey !== token,
            );
            for (const p of stale) {
              // `kind: null` is the spec's delete. app_id + pushkey identify
              // the row, so this can only ever remove this app's own rows.
              await fetch(`${auth.homeserver}/_matrix/client/v3/pushers/set`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${auth.accessToken}`,
                },
                body: JSON.stringify({ kind: null, app_id: p.app_id, pushkey: p.pushkey }),
              });
            }
            if (stale.length) console.log(`Removed ${stale.length} stale pusher(s)`);
          }
        } catch (err) {
          // Never fatal: the pusher that matters is already registered above,
          // and duplicates are a nuisance rather than a loss.
          console.warn("Pruning stale pushers failed:", err);
        }
      } catch (err) {
        console.warn("Native push setup failed:", err);
      }
    };

    registerNativePusher();

    PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const roomId = action.notification?.data?.roomId;
      if (typeof roomId === "string" && roomId) onOpenRoom?.(roomId);
    });

    return () => {
      cancelled = true;
      PushNotifications.removeAllListeners().catch(() => {});
    };
  }, [enabled, onOpenRoom]);

  useEffect(() => {
    if (!enabled) return;
    if (Capacitor.isNativePlatform()) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    const registerPusher = async () => {
      let phase = "starting web push setup";
      try {
        phase = "registering service worker";
        await navigator.serviceWorker.register("/sw.js");
        phase = "waiting for service worker readiness";
        const reg = await navigator.serviceWorker.ready;
        phase = "requesting notification permission";
        const permission = Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
        if (permission !== "granted") return;

        phase = "reading existing push subscription";
        const existing = await reg.pushManager.getSubscription();
        phase = "creating browser push subscription";
        const subscription =
          existing ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          }));

        phase = "loading Matrix auth";
        const { loadAuth } = await import("../lib/auth");
        const auth = loadAuth();

        if (!auth) {
          console.warn("Push setup: no auth found, skipping pusher registration");
          return;
        }

        const pushkey = JSON.stringify(subscription.toJSON());
        // Lets the gateway tell this device apart from the others when deciding
        // whose notifications to skip (see src/lib/presence.ts).
        setPresencePushkey(pushkey);

        const pusher = {
          kind: "http",
          app_id: "com.kafagoz.construct",
          app_display_name: "Construct",
          device_display_name: navigator.userAgent.includes("iPhone") ? "iPhone" : "Browser",
          pushkey,
          lang: "en",
          data: {
            url: "https://construct.kafagoz.com/_matrix/push/v1/notify",
            format: "event_notification",
          },
        };

        // Through our own origin rather than straight at the homeserver: the
        // direct call fails with "TypeError: Load failed" in Safari, which had
        // pusher registration broken without it being obvious. The proxy also
        // retires this account's older rows for the same app_id, because the
        // listing call it needs is blocked by the same wall.
        phase = "registering Matrix pusher through Construct proxy";
        const pusherRes = await fetch("/api/register-pusher", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            homeserver: auth.homeserver,
            accessToken: auth.accessToken,
            pusher,
          }),
        });
        if (!pusherRes.ok) {
          throw new Error(`Matrix pusher registration failed: HTTP ${pusherRes.status}`);
        }
        const { pruned = 0 } = await pusherRes.json().catch(() => ({}));
        console.log(`Push pusher registered successfully (retired ${pruned} stale pusher(s))`);

      } catch (err) {
        console.warn(`Push setup failed during ${phase}:`, err);
        try {
          const { loadAuth } = await import("../lib/auth");
          const auth = loadAuth();
          if (auth) {
            const txnId = `push-err-${Date.now()}`;
            const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            await fetch(`${auth.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent("!DpRWqhWOHJAxyvjOGI:matrix.org")}/send/m.room.message/${txnId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.accessToken}` },
              body: JSON.stringify({ msgtype: "m.text", body: `[Construct push setup failed] during ${phase}: ${errMsg}` }),
            });
          }
        } catch {
          // Best effort: avoid a recursive push-setup error report if Matrix send fails.
        }
      }
    };

    registerPusher();

    const onVisible = () => {
      if (document.visibilityState === "visible") registerPusher();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled]);
}

export { ACTIVE_TTL_MS, APP_ACTIVE_CACHE, APP_ACTIVE_KEY };
