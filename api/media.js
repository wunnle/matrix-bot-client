/**
 * Proxy Matrix media URLs with auth token.
 * Usage: /api/media?mxc=mxc://matrix.org/abc123
 */
export default async function handler(req, res) {
  const { mxc } = req.query;
  if (!mxc || !mxc.startsWith("mxc://")) {
    return res.status(400).json({ error: "invalid mxc" });
  }

  const [server, mediaId] = mxc.slice(6).split("/");
  if (!server || !mediaId) return res.status(400).json({ error: "invalid mxc" });

  const url = `https://${server}/_matrix/client/v1/media/download/${server}/${mediaId}`;
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
