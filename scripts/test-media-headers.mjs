// The media proxy (api/media.js) serves untrusted matrix.org uploads from our
// own origin, so only non-scriptable media may render inline; everything else
// must download, and every response is nosniff + CSP-sandboxed.
// Run: node scripts/test-media-headers.mjs
import assert from 'node:assert/strict'

process.env.MATRIX_ACCESS_TOKEN = 'owner-token'
const { default: handler } = await import('../api/media.js')

let upstreamHeaders = {}
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: new Headers(upstreamHeaders),
  arrayBuffer: async () => new TextEncoder().encode('<script>alert(1)</script>').buffer,
})

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    send(body) { this.body = body; return this },
    end() { return this },
  }
}

async function get(headers, mxc = 'mxc://matrix.org/abc123') {
  upstreamHeaders = headers
  const res = fakeRes()
  await handler({ query: { mxc } }, res)
  return res
}

function assertHardened(res) {
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['content-security-policy'], "sandbox; default-src 'none'")
}

// image/png: inline, as before (avatars, push icons).
{
  const res = await get({ 'content-type': 'image/png', 'content-disposition': 'inline; filename="a.png"' })
  assertHardened(res)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['content-disposition'], undefined)
  assert.ok(Buffer.isBuffer(res.body))
}

// image/svg+xml: can carry script, so it downloads.
{
  const res = await get({ 'content-type': 'image/svg+xml', 'content-disposition': 'inline; filename="x.svg"' })
  assertHardened(res)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.headers['content-disposition'], `attachment; filename="x.svg"; filename*=UTF-8''x.svg`)
}

// text/html: downloads, keeping a UTF-8 filename.
{
  const res = await get({ 'content-type': 'text/html; charset=utf-8', 'content-disposition': "inline; filename*=utf-8''sayfa%20%C3%BC.html" })
  assertHardened(res)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.headers['content-disposition'], `attachment; filename="sayfa _.html"; filename*=UTF-8''sayfa%20%C3%BC.html`)
}

// application/pdf: downloads; no upstream filename means a bare attachment.
{
  const res = await get({ 'content-type': 'application/pdf' })
  assertHardened(res)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.headers['content-disposition'], 'attachment')
}

// Case and parameters don't sneak SVG through; a path in the filename is flattened.
{
  const res = await get({ 'content-type': 'Image/SVG+XML; charset=utf-8', 'content-disposition': 'attachment; filename="../../e\\"vil.svg"' })
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.headers['content-disposition'], `attachment; filename=".._.._e_vil.svg"; filename*=UTF-8''.._.._e_vil.svg`)
}

// No upstream type at all: download, not the old image/png guess.
{
  const res = await get({})
  assert.equal(res.headers['content-type'], 'application/octet-stream')
}

// Video and audio stay inline.
for (const type of ['video/mp4', 'audio/ogg']) {
  const res = await get({ 'content-type': type })
  assert.equal(res.headers['content-type'], type)
  assert.equal(res.headers['content-disposition'], undefined)
}

// Error responses carry the headers too.
{
  const res = await get({}, 'not-an-mxc')
  assert.equal(res.statusCode, 400)
  assertHardened(res)
}

console.log('media headers: ok')
