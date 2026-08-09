import { useEffect } from "react";
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
      try {
        await navigator.serviceWorker.register("/sw.js");
        const reg = await navigator.serviceWorker.ready;
        const permission = Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
        if (permission !== "granted") return;

        const existing = await reg.pushManager.getSubscription();
        const subscription =
          existing ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          }));

        const { loadAuth } = await import("../lib/auth");
        const auth = loadAuth();

        if (!auth) {
          console.warn("Push setup: no auth found, skipping pusher registration");
          return;
        }

        const pushkey = JSON.stringify(subscription.toJSON());

        await fetch(`${auth.homeserver}/_matrix/client/v3/pushers/set`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.accessToken}`,
          },
          body: JSON.stringify({
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
          }),
        });
        console.log("Push pusher registered successfully");
      } catch (err) {
        console.warn("Push setup failed:", err);
        try {
          const { loadAuth } = await import("../lib/auth");
          const auth = loadAuth();
          if (auth) {
            const txnId = `push-err-${Date.now()}`;
            const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            await fetch(`${auth.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent("!DpRWqhWOHJAxyvjOGI:matrix.org")}/send/m.room.message/${txnId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.accessToken}` },
              body: JSON.stringify({ msgtype: "m.text", body: `[Construct push setup failed] ${errMsg}` }),
            });
          }
        } catch {}
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
