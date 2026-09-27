// POST /api/send-message { room, text } → sends message via Matrix HTTP API
// Auth: x-intent-secret header — never the URL or body. See _auth.js.
import crypto from 'crypto'
import { authorized } from './_auth.js'

const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix-client.matrix.org'
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://construct.kafagoz.com')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-intent-secret')

  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method !== 'POST') return res.status(405).end()

  if (!(await authorized(req))) return res.status(403).json({ error: 'forbidden' })

  const { room, text, source, activityId } = req.body ?? {}
  if (!room || !text) return res.status(400).json({ error: 'missing room or text' })
  if (!ACCESS_TOKEN) return res.status(500).json({ error: 'server not configured' })

  const tappedActivity = typeof activityId === 'string' && activityId && activityId.length <= 64
    ? activityId
    : null
  // A Live Activity button tap gets a transaction id derived from the activity
  // and the button, so the homeserver's own idempotency drops a repeat: the
  // same tap arrived twice, ~25s apart, in testing. Pressing one button twice
  // on one activity never means anything new. Everything else stays random.
  const txnId = tappedActivity
    ? `la-${crypto.createHash('sha256').update(`${room}\n${tappedActivity}\n${text}`).digest('hex').slice(0, 32)}`
    : crypto.randomUUID()
  const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(decodeURIComponent(room))}/send/m.room.message/${txnId}`

  const event = {
    msgtype: 'm.text',
    body: text,
    'com.construct.capabilities': ['actionable'],
    'com.construct.client': 'construct-web',
  }
  if (source) event['com.construct.source'] = source
  // Tells the bot which activity was answered.
  if (tappedActivity) event['com.construct.activity_id'] = tappedActivity

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
