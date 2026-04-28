// Simple single-slot room intent store.
// POST /api/room-intent?key=SECRET { room } → stores room
// GET  /api/room-intent?key=SECRET         → returns { room } and clears it

const SECRET = process.env.INTENT_SECRET || 'construct-intent'

let pendingRoom = null
let pendingAction = null
let expiresAt = 0

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://construct.kafagoz.com')

  const { key } = req.query
  if (key !== SECRET) return res.status(403).json({ error: 'forbidden' })

  if (req.method === 'POST') {
    const { room, action } = req.body ?? {}
    if (!room) return res.status(400).json({ error: 'missing room' })
    pendingRoom = room
    pendingAction = action ?? null
    expiresAt = Date.now() + 60_000
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'GET') {
    if (!pendingRoom || Date.now() > expiresAt) {
      pendingRoom = null
      pendingAction = null
      return res.status(200).json({ room: null, action: null })
    }
    const room = pendingRoom
    const action = pendingAction
    pendingRoom = null
    pendingAction = null
    return res.status(200).json({ room, action })
  }

  res.status(405).end()
}
