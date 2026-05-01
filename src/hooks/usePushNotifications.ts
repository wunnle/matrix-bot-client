import { useEffect } from "react";

const VAPID_PUBLIC_KEY = "BHAWGVTndxe9FH-hZmiPSoLsts1NOJLIx9uwVlJIXwDYf8JeXFb1xrKvCLIR5We0djZcWlXIvwiWW2DPLQ8SHdA";

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray.buffer as ArrayBuffer;
}

function getActiveRoomIdFromPath(): string | null {
  const m = location.pathname.match(/^\/rooms\/(.+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

export function usePushNotifications(enabled: boolean) {
  // When a push targets the room we already have open in the foreground, the SW asks us to
  // confirm — we tell it to skip showing the system notification.
  useEffect(() => {
    if (!enabled) return;
    if (!("serviceWorker" in navigator)) return;

    const onServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type !== "PUSH_SUPPRESS_CHECK") return;
      const { id, roomId } = event.data as { id: string; roomId: string };
      if (document.visibilityState !== "visible") return;
      const current = getActiveRoomIdFromPath();
      const avatars = JSON.parse(localStorage.getItem('room_avatars') || '{}')
      const icon = roomId ? (avatars[roomId] ?? null) : null
      if (current && roomId && current === roomId) {
        navigator.serviceWorker.controller?.postMessage({
          type: "PUSH_SUPPRESS_RESULT",
          id,
          suppress: true,
          icon,
        });
      } else if (icon) {
        navigator.serviceWorker.controller?.postMessage({
          type: "PUSH_ICON_RESULT",
          id,
          icon,
        });
      }
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

    (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;

        const existing = await reg.pushManager.getSubscription();
        const subscription =
          existing ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          }));

        await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscription),
        });

        // Register Matrix pusher so matrix.org delivers pushes directly
        const { loadAuth } = await import("../lib/auth");
        const auth = loadAuth();
        if (!auth) {
          console.warn("Push setup: no auth found, skipping pusher registration");
        }
        if (auth) {
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
              pushkey: subscription.endpoint,
              lang: "en",
              data: {
                url: "https://construct.kafagoz.com/_matrix/push/v1/notify",
                format: "event_notification",
              },
            }),
          });
          console.log("Push pusher registered successfully");
        }
      } catch (err) {
        console.warn("Push setup failed:", err);
        // Report failure to Matrix so we can debug without DevTools
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
    })();
  }, [enabled]);
}
