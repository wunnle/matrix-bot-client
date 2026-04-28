const store = new Map()

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method === 'POST') {
    const { room } = req.body ?? {}
    if (!room) return res.status(400).json({ error: 'missing room' })
    const token = Math.random().toString(36).slice(2)
    store.set(token, { room, expires: Date.now() + 30_000 })
    return res.status(200).json({ token })
  }

  if (req.method === 'GET') {
    const { token } = req.query
    if (!token) return res.status(400).json({ error: 'missing token' })
    const entry = store.get(token)
    if (!entry || Date.now() > entry.expires) {
      store.delete(token)
      return res.status(404).json({ error: 'not found' })
    }
    store.delete(token)
    return res.status(200).json({ room: entry.room })
  }

  res.status(405).end()
}
