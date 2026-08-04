const APP_ACTIVE_CACHE = "construct-app-state";
const APP_ACTIVE_KEY = "/app-active-ts";
const ACTIVE_TTL_MS = 15_000;

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
      // Drop superseded shell caches only — APP_ACTIVE_CACHE above is live state.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("construct-shell-") && n !== SHELL_CACHE)
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
