#!/usr/bin/env node
// Sends a local image into the agent room the current turn is running in, so a
// screenshot can be looked at in the chat instead of described in text.
// Usage: node scripts/send-image.mjs /path/to/shot.png ["optional caption"]
import fs from 'node:fs'
import path from 'node:path'

const [file, ...rest] = process.argv.slice(2)
if (!file) die('Usage: send-image.mjs <file> ["caption"]')
if (!fs.existsSync(file)) die(`No such file: ${file}`)
const caption = rest.join(' ').trim() || path.basename(file)

const roomId = process.env.AGENT_ROOM_ID
if (!roomId) die('AGENT_ROOM_ID is not set — this only runs inside an agent room turn.')

const sessionFile = path.join(import.meta.dirname, '.claude-bot-store', '.session.json')
if (!fs.existsSync(sessionFile)) die(`No bot session at ${sessionFile}`)
const { access_token } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
if (!access_token) die(`No access_token in ${sessionFile}`)

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}
const ext = path.extname(file).toLowerCase()
const mimetype = MIME[ext]
if (!mimetype) die(`Not an image extension this sends: ${ext || '(none)'}`)

const homeserver = process.env.HOMESERVER ?? 'https://matrix.org'
const auth = { authorization: `Bearer ${access_token}` }
const data = fs.readFileSync(file)

const upload = await withRetry(() => fetch(
  `${homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(path.basename(file))}`,
  { method: 'POST', headers: { ...auth, 'content-type': mimetype }, body: data },
))
if (!upload.ok) die(`Upload failed (${upload.status}): ${await upload.text()}`)
const { content_uri } = await upload.json()

// Unencrypted m.image. Agent rooms carry no m.room.encryption state; if that
// ever changes this has to go through the bot's crypto store instead. The
// txnId stays fixed across retries, so a retried send cannot post twice.
const txnId = `img-${Date.now()}`
const send = await withRetry(() => fetch(
  `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
  {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'm.image',
      body: caption,
      url: content_uri,
      info: { mimetype, size: data.length },
    }),
  },
))
if (!send.ok) die(`Send failed (${send.status}): ${await send.text()}`)
console.log(`Sent ${file} → ${roomId}`)

// The bot posts often enough that matrix.org rate-limits it (429 with
// retry_after_ms, usually a second or three). Wait what it asks and try again,
// a few times, instead of failing and leaving the retry to whoever called us.
async function withRetry(request, tries = 4) {
  for (let i = 1; ; i++) {
    const res = await request()
    if (res.status !== 429 || i === tries) return res
    let wait = Number(res.headers.get('retry-after')) * 1000 || 0
    try { wait = (await res.json()).retry_after_ms ?? wait } catch {}
    await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 1000), 30_000) + 250))
  }
}

function die(msg) { console.error(msg); process.exit(1) }
