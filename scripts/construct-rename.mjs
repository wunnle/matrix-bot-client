#!/usr/bin/env node
// Renames the agent room a turn is running in, so the room list says what the
// agent is working on (the Linear issue id first when there is one).
//
//   construct-rename "BEN-359 Scruffy captures" [--room !id]
//
// The bot sets m.room.name with its own live client: it created the room and
// holds the power level for it, and it knows which homeserver the room is on.
// --room defaults to $AGENT_ROOM_ID, set for every agent turn.
// Installed as ~/.local/bin/construct-rename (a symlink here); also behind
// scripts/room-rename.mjs, which the room-rename skill used to call.

const args = process.argv.slice(2)
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: construct-rename "New name" [--room !id]')
  process.exit(args.length ? 0 : 1)
}
const r = args.indexOf('--room')
let roomId = process.env.AGENT_ROOM_ID
if (r >= 0) {
  roomId = args[r + 1]
  if (!roomId || roomId.startsWith('--')) die('--room needs a value')
  args.splice(r, 2)
}
const name = args.join(' ').replace(/\s+/g, ' ').trim()
if (!name) die('Give the new name.')
if (!roomId) die('No room: pass --room !id (AGENT_ROOM_ID is not set).')

const port = Number(process.env.AGENT_APPROVAL_PORT ?? 8787)
let res
try {
  res = await fetch(`http://127.0.0.1:${port}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, name }),
  })
} catch (e) {
  die(`The bot is not reachable on 127.0.0.1:${port} (${e.message}).`)
}
if (!res.ok) die(`The bot could not rename it (${res.status}): ${await res.text()}`)
const { name: set } = await res.json().catch(() => ({ name }))
console.log(`Renamed ${roomId} → ${set ?? name}`)

function die(msg) {
  console.error(msg)
  process.exit(1)
}
