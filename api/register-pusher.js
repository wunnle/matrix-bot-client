/**
 * Pusher registration proxy.
 *
 * The browser cannot call the homeserver's /pushers endpoints directly — that
 * fetch fails with "TypeError: Load failed" in Safari, which is how push setup
 * had been silently broken (see the [Construct push setup failed] reports).
 * Same-origin through this route, it works.
 *
 * It registers the caller's pusher and then retires that account's older rows
 * for the same app_id. Both halves live here rather than in the client because
 * the listing call is blocked by the same wall as the registration, so a
 * client-side prune could never run.
 *
 * Why the prune matters: Synapse runs one HTTP pusher per row and POSTs the
 * push gateway once for each. A browser push subscription is minted fresh
 * whenever the service worker resubscribes, so rows accumulated with nothing
 * removing them — 37 of them — and every row whose endpoint still resolved
 * produced its own notification and its own Live Activity for a single
 * message.
 */

/** Homeservers this proxy will talk to. Without it the route is an open relay:
    it takes both the destination and the bearer token from the request body,
    so any caller could have this deployment make an authenticated request to a
    host of their choosing. */
const ALLOWED_HOMESERVERS = new Set(
  [process.env.MATRIX_HOMESERVER, "https://matrix-client.matrix.org", "https://matrix.org"]
    .filter(Boolean)
    .map((h) => h.replace(/\/$/, "")),
);

function normalizeHomeserver(homeserver) {
  if (typeof homeserver !== "string") return null;
  try {
    const url = new URL(homeserver);
    if (url.protocol !== "https:") return null;
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    const base = url.toString().replace(/\/$/, "");
    return ALLOWED_HOMESERVERS.has(base) ? base : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const { homeserver, accessToken, pusher } = req.body ?? {};
  const base = normalizeHomeserver(homeserver);
  if (!base || typeof accessToken !== "string" || !accessToken || !pusher?.app_id || !pusher?.pushkey) {
    return res.status(400).json({ error: "missing or disallowed homeserver, accessToken, or pusher" });
  }

  const auth = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const setPusher = (body) =>
    fetch(`${base}/_matrix/client/v3/pushers/set`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });

  try {
    const upstream = await setPusher(pusher);
    const text = await upstream.text();
    if (!upstream.ok) {
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      return res.send(text || "{}");
    }

    // Only after the new row is in place: deleting first would leave a window
    // with no pusher at all, and a failure partway would end with the device
    // silently unsubscribed.
    let pruned = 0;
    try {
      const listRes = await fetch(`${base}/_matrix/client/v3/pushers`, { headers: auth });
      if (listRes.ok) {
        const { pushers = [] } = await listRes.json();
        const stale = pushers.filter(
          (p) => p.app_id === pusher.app_id && p.pushkey && p.pushkey !== pusher.pushkey,
        );
        for (const p of stale) {
          // `kind: null` is the spec's delete, keyed on app_id + pushkey, so
          // this can only remove rows belonging to the app that just
          // registered — never another client's.
          const del = await setPusher({ kind: null, app_id: p.app_id, pushkey: p.pushkey });
          if (del.ok) pruned += 1;
        }
      }
    } catch {
      // Non-fatal. The pusher that matters is registered; duplicates are a
      // nuisance rather than a lost notification, and the next run retries.
    }

    return res.status(200).json({ ok: true, pruned });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: `Matrix pusher registration proxy failed: ${message}` });
  }
}
