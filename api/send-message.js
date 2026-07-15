// POST /api/send-message { key, room, text } → sends message via Matrix HTTP API
// The secret travels in the body (or x-intent-secret header), never the URL.
import crypto from 'crypto'

const SECRET = process.env.INTENT_SECRET
const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix-client.matrix.org'
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://construct.kafagoz.com')

  if (req.method === 'OPTIONS') return res.status(200).end()

  if (!SECRET) return res.status(500).json({ error: 'server not configured' })

  if (req.method !== 'POST') return res.status(405).end()

  const { room, text, source, key: bodyKey } = req.body ?? {}
  const key = req.headers['x-intent-secret'] ?? bodyKey
  if (key !== SECRET) return res.status(403).json({ error: 'forbidden' })
  if (!room || !text) return res.status(400).json({ error: 'missing room or text' })
  if (!ACCESS_TOKEN) return res.status(500).json({ error: 'server not configured' })

  const txnId = crypto.randomUUID()
  const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(decodeURIComponent(room))}/send/m.room.message/${txnId}`

  const event = {
    msgtype: 'm.text',
    body: text,
    'com.construct.capabilities': ['actionable'],
    'com.construct.client': 'construct-web',
  }
  if (source) event['com.construct.source'] = source

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    return res.status(response.status).json({ error: err.error ?? 'matrix send failed' })
  }

  return res.status(200).json({ ok: true })
}
