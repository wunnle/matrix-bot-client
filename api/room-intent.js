// Simple single-slot room intent store.
// POST /api/room-intent { room } → stores room
// GET  /api/room-intent          → returns { room } and clears it
// Auth: x-intent-secret header — never the URL or body.

const SECRET = process.env.INTENT_SECRET

let pendingRoom = null
let pendingAction = null
let pendingText = null
let expiresAt = 0

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://construct.kafagoz.com')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-intent-secret')

  if (!SECRET) return res.status(500).json({ error: 'server not configured' })

  if (req.headers['x-intent-secret'] !== SECRET) return res.status(403).json({ error: 'forbidden' })

  if (req.method === 'POST') {
    const { room, action, text } = req.body ?? {}
    if (!room) return res.status(400).json({ error: 'missing room' })
    pendingRoom = room
    pendingAction = action !== 'send' ? (action ?? null) : null
    pendingText = action !== 'send' ? (text ?? null) : null
    expiresAt = Date.now() + 5_000
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'GET') {
    if (!pendingRoom || Date.now() > expiresAt) {
      pendingRoom = null
      pendingAction = null
      pendingText = null
      return res.status(200).json({ room: null, action: null, text: null })
    }
    const room = pendingRoom
    const action = pendingAction
    const text = pendingText
    pendingRoom = null
    pendingAction = null
    pendingText = null
    return res.status(200).json({ room, action, text })
  }

  res.status(405).end()
}
