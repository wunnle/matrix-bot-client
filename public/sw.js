/* ── App shell cache ───────────────────────────────────────────────────
   The native app loads the web app over the network (capacitor.config.ts
   server.url) rather than from a bundled copy, so without this a launch with
   no connectivity would get an error page instead of an app. Caching the
   shell keeps cold starts working offline — and fast when online, since the
   hashed build assets are served from disk.

   Only same-origin GETs are touched: /api and /_matrix must always hit the
   network, and cross-origin requests (matrix.org, media) are left alone. */
const SHELL_CACHE = "construct-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.add("/"))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop superseded shell caches, and the "app is active" timestamp cache
      // the push handler no longer reads.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (n) =>
              (n.startsWith("construct-shell-") && n !== SHELL_CACHE) ||
              n === "construct-app-state"
          )
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

const CACHEABLE_ASSET = /\.(?:js|css|woff2?|ttf|png|jpg|jpeg|svg|webp|wasm)$/;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_matrix/")) return;

  // Every in-app route resolves to index.html (see vercel.json rewrites), so a
  // single cached "/" backs the whole router. Network-first keeps a deploy from
  // being masked by the cache; the copy is only used when the network fails.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          const hit = await cache.match("/");
          if (hit) return hit;
          return new Response("Offline", { status: 503, statusText: "Offline" });
        })
    );
    return;
  }

  // Build assets are content-hashed, so a cache hit can never be stale.
  if (!CACHEABLE_ASSET.test(url.pathname)) return;
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
    )
  );
});

/* Every push shows a notification. Staying quiet while the app is open (it
   toasts other rooms itself) is the gateway's job: api/matrix-push.js doesn't
   send to a visible client at all. Suppressing here instead meant pushes that
   showed nothing, which iOS Safari treats as silent and answers by revoking
   the subscription. */
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Hermes", body: "" };
  const roomId = data.roomId;

  event.waitUntil(
    (async () => {
      // Open windows refresh that room's unread count straight away.
      if (roomId) {
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of clientList) c.postMessage({ type: "PUSH_RECEIVED", roomId });
      }

      await self.registration.showNotification(data.title, {
        body: data.body,
        icon: data.icon || "/icon-192.png",
        badge: "/icon-192.png",
        data: { roomId: roomId ?? null },
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
