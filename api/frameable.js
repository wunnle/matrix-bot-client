/**
 * Whether a page lets Construct frame it, for the room sidebar's Browser tab.
 * GET /api/frameable?url=… → { frameable: true | false | null, url, reason? }
 *
 * A browser won't say why a cross-origin frame came up blank, so the app asks
 * here first: this fetches the page and reads the two headers that refuse
 * framing, X-Frame-Options and CSP frame-ancestors. `url` is where redirects
 * ended up. null means the page couldn't be reached from here, which is the
 * normal case for tailnet addresses (the app skips asking about those).
 *
 * Gated by authorized(), like the other endpoints: it fetches what it's given.
 */
import { authorized } from "./_auth.js";
import { cors } from "./_cors.js";

const APP_ORIGIN = "https://construct.kafagoz.com";
const TIMEOUT_MS = 6000;

// frame-ancestors' sources, from every CSP header (they all apply).
function frameAncestors(csp) {
  if (!csp) return null;
  const sources = [];
  let found = false;
  for (const policy of csp.split(",")) {
    for (const directive of policy.split(";")) {
      const [name, ...values] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() !== "frame-ancestors") continue;
      found = true;
      sources.push(values.map((v) => v.toLowerCase()));
    }
  }
  return found ? sources : null;
}

function allowsApp(sources) {
  const host = new URL(APP_ORIGIN).host;
  const ok = (s) =>
    s === "*" || s === "https:" || s === APP_ORIGIN || s === host ||
    (s.startsWith("*.") && host.endsWith(s.slice(1))) ||
    (s.startsWith("https://*.") && host.endsWith(s.slice(9)));
  // Each policy must allow it on its own.
  return sources.every((list) => list.some(ok));
}

export function verdict(headers) {
  const ancestors = frameAncestors(headers.get("content-security-policy"));
  // frame-ancestors overrides X-Frame-Options where both are sent.
  if (ancestors) {
    return allowsApp(ancestors)
      ? { frameable: true }
      : { frameable: false, reason: "frame-ancestors" };
  }
  const xfo = headers.get("x-frame-options")?.trim().toLowerCase();
  if (xfo && xfo !== "allowall") return { frameable: false, reason: "x-frame-options" };
  return { frameable: true };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!(await authorized(req))) return res.status(401).json({ error: "unauthorized" });

  let target;
  try { target = new URL(String(req.query?.url ?? "")); } catch { target = null; }
  if (!target || !/^https?:$/.test(target.protocol)) {
    return res.status(400).json({ error: "an http(s) url is required" });
  }

  try {
    const r = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; Construct frame check)" },
    });
    // Only the headers matter; don't download the page.
    r.body?.cancel().catch(() => {});
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).json({ url: r.url, ...verdict(r.headers) });
  } catch (e) {
    return res.status(200).json({ frameable: null, url: target.href, reason: e?.name === "TimeoutError" ? "timeout" : "unreachable" });
  }
}
