const APP_ACTIVE_CACHE = "construct-app-state";
const APP_ACTIVE_KEY = "/app-active-ts";
const ACTIVE_TTL_MS = 15_000;

async function isAppActive() {
  try {
    const cache = await caches.open(APP_ACTIVE_CACHE);
    const res = await cache.match(APP_ACTIVE_KEY);
    if (!res) return false;
    const ts = parseInt(await res.text(), 10);
    return !isNaN(ts) && Date.now() - ts < ACTIVE_TTL_MS;
  } catch {
    return false;
  }
}

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Hermes", body: "" };
  const roomId = data.roomId;

  event.waitUntil(
    (async () => {
      const show = (icon) =>
        self.registration.showNotification(data.title, {
          body: data.body,
          icon: icon || data.icon || "/icon-192.png",
          badge: "/icon-192.png",
          data: { roomId: data.roomId },
        });

      if (!roomId) {
        await show(null);
        return;
      }

      // App wrote an active timestamp recently — suppress, let toast handle it
      if (await isAppActive()) {
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of clientList) {
          c.postMessage({ type: "PUSH_SUPPRESS_CHECK", id: null, roomId, title: data.title, body: data.body });
        }
        return;
      }

      await show(null);
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const roomId = event.notification.data && event.notification.data.roomId;
  const url = roomId ? "/rooms/" + encodeURIComponent(roomId) : "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
