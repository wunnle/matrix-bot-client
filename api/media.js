/**
 * Proxy Matrix media URLs with auth token.
 * Usage: /api/media?mxc=mxc://matrix.org/abc123
 *
 * The access token is only ever sent to MATRIX_HOMESERVER, never to the
 * server named in the mxc URI, and only allowlisted media servers are
 * proxied at all.
 */
const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix-client.matrix.org";
const ALLOWED_SERVERS = new Set(
  (process.env.MEDIA_ALLOWED_SERVERS || "matrix.org")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export default async function handler(req, res) {
  const { mxc } = req.query;
  if (!mxc || !mxc.startsWith("mxc://")) {
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

  const url = `${HOMESERVER}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
  const token = process.env.MATRIX_ACCESS_TOKEN;

  try {
    const upstream = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!upstream.ok) return res.status(upstream.status).end();

    const contentType = upstream.headers.get("content-type") || "image/png";
    const buffer = await upstream.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
