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
      if (ourClients.length === 0) {
        await show(null);
        return;
      }

      // If any client is focused/visible, suppress immediately without waiting for reply
      const hasVisibleClient = ourClients.some((c) => c.visibilityState === "visible");
      if (hasVisibleClient) {
        for (const c of ourClients) {
          c.postMessage({ type: "PUSH_SUPPRESS_CHECK", id, roomId, title: data.title, body: data.body });
        }
        return;
      }

      const id =
        (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) || String(Date.now() + Math.random());

      await new Promise((resolve) => {
        let done = false;
        const finish = async (suppressed, icon) => {
          if (done) return;
          done = true;
          self.removeEventListener("message", onMessage);
          clearTimeout(t);
          if (!suppressed) {
            await show(icon);
          }
          resolve();
        };

        const onMessage = (e) => {
          if (!e.data || e.data.id !== id) return;
          if (e.data.type === "PUSH_SUPPRESS_RESULT" && e.data.suppress === true) {
            finish(true, null);
          } else if (e.data.type === "PUSH_SUPPRESS_RESULT" || e.data.type === "PUSH_ICON_RESULT") {
            finish(false, e.data.icon || null);
          }
        };

        self.addEventListener("message", onMessage);
        const t = setTimeout(() => {
          void finish(false, null);
        }, 1500);

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
