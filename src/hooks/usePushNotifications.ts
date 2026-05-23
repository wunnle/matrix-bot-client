import { useEffect } from "react";

const VAPID_PUBLIC_KEY = "BHAWGVTndxe9FH-hZmiPSoLsts1NOJLIx9uwVlJIXwDYf8JeXFb1xrKvCLIR5We0djZcWlXIvwiWW2DPLQ8SHdA";
const APP_ACTIVE_CACHE = "construct-app-state";
const APP_ACTIVE_KEY = "/app-active-ts";
// SW suppresses push if timestamp is fresher than this
const ACTIVE_TTL_MS = 30_000;

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

export function usePushNotifications(enabled: boolean) {
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

  useEffect(() => {
    if (!enabled) return;
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
