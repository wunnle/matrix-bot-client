// POST /api/wait-reply { room, since } → long-polls the room for the next
// message from someone other than the bot account, newer than `since` (ms).
// Returns { reply: string|null, sender, ts }. Auth: x-intent-secret header.
//
// Used by the native "Ask Construct" App Intent after it posts a message, to
// surface the reply in a Live Activity without launching the app. Kept under
// ~9s so it fits a single serverless invocation; the intent may call again.

const SECRET = process.env.INTENT_SECRET
const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix-client.matrix.org'
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN

const POLL_MS = 1500
const MAX_MS = 9000

let cachedUserId = null
async function ownUserId() {
  if (cachedUserId) return cachedUserId
  const r = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  })
  if (!r.ok) return null
  const j = await r.json().catch(() => ({}))
  cachedUserId = j.user_id ?? null
  return cachedUserId
}

async function latestReply(room, since, selfId) {
  const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(decodeURIComponent(room))}/messages?dir=b&limit=10`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } })
  if (!r.ok) return null
  const j = await r.json().catch(() => ({}))
  for (const ev of j.chunk ?? []) {
    if (ev.type !== 'm.room.message') continue
    if (ev.sender === selfId) continue
    if ((ev.origin_server_ts ?? 0) <= since) break // older than the wait window
    // Streamed edits (m.replace) carry the real text in m.new_content;
    // the plain body is a "* ..." fallback.
    const content = ev.content?.['m.new_content'] ?? ev.content
    const body = content?.body
    if (body) return { reply: body, sender: ev.sender, ts: ev.origin_server_ts }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://construct.kafagoz.com')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-intent-secret')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!SECRET) return res.status(500).json({ error: 'server not configured' })
  if (req.method !== 'POST') return res.status(405).end()
  if (req.headers['x-intent-secret'] !== SECRET) return res.status(403).json({ error: 'forbidden' })
  if (!ACCESS_TOKEN) return res.status(500).json({ error: 'server not configured' })

  const { room, since } = req.body ?? {}
  if (!room) return res.status(400).json({ error: 'missing room' })
  const sinceTs = Number(since) || 0

  const selfId = await ownUserId()
  const deadline = Date.now() + MAX_MS
  while (Date.now() < deadline) {
    const hit = await latestReply(room, sinceTs, selfId)
    if (hit) return res.status(200).json(hit)
    await sleep(POLL_MS)
  }
  return res.status(200).json({ reply: null })
}
