#!/usr/bin/env node
// Renames the agent room the current turn is running in. Backs the
// /room-rename skill.
// Usage: node scripts/room-rename.mjs "New Name"
import fs from 'node:fs'
import path from 'node:path'

const name = process.argv.slice(2).join(' ').trim()
if (!name) die('Usage: room-rename.mjs "New Name"')

const roomId = process.env.AGENT_ROOM_ID
if (!roomId) die('AGENT_ROOM_ID is not set — this only runs inside an agent room turn.')

// The bot's session is the only credential that can set m.room.name here: it
// creates the room, and the invited owner only gets PL50.
const sessionFile = path.join(import.meta.dirname, '.claude-bot-store', '.session.json')
if (!fs.existsSync(sessionFile)) die(`No bot session at ${sessionFile}`)
const { access_token } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
if (!access_token) die(`No access_token in ${sessionFile}`)

const homeserver = process.env.HOMESERVER ?? 'https://matrix.org'
const res = await fetch(
  `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`,
  {
    method: 'PUT',
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  },
)
if (!res.ok) die(`Rename failed (${res.status}): ${await res.text()}`)
console.log(`Renamed ${roomId} → ${name}`)

function die(msg) { console.error(msg); process.exit(1) }
