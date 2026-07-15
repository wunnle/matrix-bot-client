// POST /api/send-file?room=!room:server&filename=photo.jpg
// Raw body = file bytes; the secret travels in the x-intent-secret header,
// never the URL. Sends native Matrix media event via Matrix media upload API.
import crypto from 'crypto'

export const config = {
  api: {
    bodyParser: false,
  },
}

const SECRET = process.env.INTENT_SECRET
const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix-client.matrix.org'
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN
const MAX_BYTES = 10 * 1024 * 1024

function safeFilename(value, contentType) {
  const fallbackExt = contentType?.split('/')?.[1]?.split(';')?.[0] || 'bin'
  const raw = typeof value === 'string' && value.trim() ? value.trim() : `upload.${fallbackExt}`
  return raw.replace(/[\r\n/\\]/g, '_').slice(0, 120)
}

function eventTypeFor(contentType) {
  if (contentType.startsWith('image/')) return { msgtype: 'm.image', type: 'm.room.message' }
  if (contentType.startsWith('video/')) return { msgtype: 'm.video', type: 'm.room.message' }
  if (contentType.startsWith('audio/')) return { msgtype: 'm.audio', type: 'm.room.message' }
  return { msgtype: 'm.file', type: 'm.room.message' }
}

async function readRawBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BYTES) {
      const err = new Error('file too large')
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://construct.kafagoz.com')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-intent-secret')

  if (req.method === 'OPTIONS') return res.status(200).end()

  if (!SECRET) return res.status(500).json({ error: 'server not configured' })

  const { room, filename, source } = req.query
  const constructSource = source || 'file-endpoint'
  if (req.headers['x-intent-secret'] !== SECRET) return res.status(403).json({ error: 'forbidden' })

  if (req.method !== 'POST') return res.status(405).end()
  if (!room) return res.status(400).json({ error: 'missing room' })
  if (!ACCESS_TOKEN) return res.status(500).json({ error: 'server not configured' })

  const contentType = (req.headers['content-type'] || 'application/octet-stream').split(';', 1)[0]
  const name = safeFilename(filename, contentType)

  let bytes
  try {
    bytes = await readRawBody(req)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'invalid body' })
  }
  if (!bytes.length) return res.status(400).json({ error: 'empty file' })

  const uploadUrl = `${HOMESERVER}/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': contentType,
    },
    body: bytes,
  })

  if (!uploadResponse.ok) {
    const err = await uploadResponse.json().catch(() => ({}))
    return res.status(uploadResponse.status).json({ error: err.error ?? 'matrix upload failed' })
  }

  const uploaded = await uploadResponse.json()
  const { msgtype, type } = eventTypeFor(contentType)
  const txnId = crypto.randomUUID()
  const sendUrl = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(decodeURIComponent(room))}/send/${type}/${txnId}`

  const event = {
    msgtype,
    body: name,
    url: uploaded.content_uri,
    info: {
      mimetype: contentType,
      size: bytes.length,
    },
    'com.construct.capabilities': ['actionable'],
    'com.construct.client': 'construct-web',
    'com.construct.source': constructSource,
  }

  const sendResponse = await fetch(sendUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  })

  if (!sendResponse.ok) {
    const err = await sendResponse.json().catch(() => ({}))
    return res.status(sendResponse.status).json({ error: err.error ?? 'matrix send failed' })
  }

  return res.status(200).json({ ok: true, content_uri: uploaded.content_uri })
}
