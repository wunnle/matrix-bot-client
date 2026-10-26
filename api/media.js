/**
 * Proxy Matrix media URLs with auth token.
 * Usage: /api/media?mxc=mxc://matrix.org/abc123&sig=<signature>
 *
 * Only links this deployment signed are served (see _media-sig.js), so the
 * route isn't an open proxy onto matrix.org with the owner's token. The access
 * token is only ever sent to MATRIX_HOMESERVER, never to the
 * server named in the mxc URI, and only allowlisted media servers are
 * proxied at all.
 *
 * Anyone can upload to matrix.org, so the bytes are untrusted and must never
 * render as a page on this origin (where localStorage holds the Matrix token).
 * Only raster images are served inline (the one use is avatars); everything
 * else, SVG included, goes out as an octet-stream download. Every response is also
 * nosniff and CSP-sandboxed in case a browser renders it anyway.
 */
import { validMediaSig } from "./_media-sig.js";

const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix-client.matrix.org";
const ALLOWED_SERVERS = new Set(
  (process.env.MEDIA_ALLOWED_SERVERS || "matrix.org")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/** The bare, lowercased media type if it's safe to render inline, else null. */
export function inlineType(contentType) {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return null;
  if (type === "image/svg+xml") return null;
  return type.startsWith("image/") ? type : null;
}

/** The filename from an upstream Content-Disposition, or null. */
export function dispositionFilename(header) {
  if (!header) return null;
  let name = null;
  const extended = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (extended) {
    try { name = decodeURIComponent(extended[2].trim()); } catch { name = null; }
  }
  if (!name) {
    const plain = header.match(/filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i);
    if (plain) name = (plain[1] ?? plain[2]).replace(/\\(.)/g, "$1").trim();
  }
  // No path parts, quotes or control characters in what we echo back.
  name = name?.replace(/[\u0000-\u001f\u007f"\\/]/g, "_").trim();
  return name || null;
}

function attachmentDisposition(filename) {
  if (!filename) return "attachment";
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");

  const { mxc, sig } = req.query;
  if (typeof mxc !== "string" || !mxc.startsWith("mxc://")) {
    return res.status(400).json({ error: "invalid mxc" });
  }

  const parts = mxc.slice(6).split("/");
  if (parts.length !== 2) return res.status(400).json({ error: "invalid mxc" });
  const [server, mediaId] = parts;
  if (!server || !/^[A-Za-z0-9_-]+$/.test(mediaId)) {
    return res.status(400).json({ error: "invalid mxc" });
  }
  if (!ALLOWED_SERVERS.has(server.toLowerCase())) {
    return res.status(403).json({ error: "media server not allowed" });
  }
  if (!validMediaSig(mxc, sig)) {
    return res.status(403).json({ error: "bad signature" });
  }

  const url = `${HOMESERVER}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
  const token = process.env.MATRIX_ACCESS_TOKEN;

  try {
    const upstream = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!upstream.ok) return res.status(upstream.status).end();

    const type = inlineType(upstream.headers.get("content-type"));
    const buffer = await upstream.arrayBuffer();

    if (type) {
      res.setHeader("Content-Type", type);
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", attachmentDisposition(
        dispositionFilename(upstream.headers.get("content-disposition"))
      ));
    }
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
