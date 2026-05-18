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

      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const ourClients = clientList.filter((c) => c.url.startsWith(self.location.origin));

      console.log(`[SW push] clients=${clientList.length} ourClients=${ourClients.length} origin=${self.location.origin} urls=${clientList.map(c=>c.url).join(',')}`);

      // Any open window means the sync client is running — suppress system notification
      // and let the in-app toast handle it instead.
      if (ourClients.length > 0) {
        for (const c of ourClients) {
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
