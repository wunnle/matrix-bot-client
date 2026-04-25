self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Hermes", body: "" };
  const roomId = data.roomId;

  event.waitUntil(
    (async () => {
      const show = () =>
        self.registration.showNotification(data.title, {
          body: data.body,
          icon: data.icon || "/icon-192.png",
          badge: "/icon-192.png",
          data: { roomId: data.roomId },
        });

      if (!roomId) {
        await show();
        return;
      }

      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const ourClients = clientList.filter((c) => c.url.startsWith(self.location.origin));
      if (ourClients.length === 0) {
        await show();
        return;
      }

      const id =
        (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) || String(Date.now() + Math.random());

      await new Promise((resolve) => {
        let done = false;
        const finish = async (suppressed) => {
          if (done) return;
          done = true;
          self.removeEventListener("message", onMessage);
          clearTimeout(t);
          if (!suppressed) {
            await show();
          }
          resolve();
        };

        const onMessage = (e) => {
          if (
            e.data &&
            e.data.type === "PUSH_SUPPRESS_RESULT" &&
            e.data.id === id &&
            e.data.suppress === true
          ) {
            finish(true);
          }
        };

        self.addEventListener("message", onMessage);
        const t = setTimeout(() => {
          void finish(false);
        }, 300);

        for (const c of ourClients) {
          c.postMessage({ type: "PUSH_SUPPRESS_CHECK", id, roomId, title: data.title, body: data.body });
        }
      });
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
