#!/usr/bin/env node
// Says which Linear issue(s) the agent room a turn runs in is working on, so
// Construct's side panel shows them (room status, scripts/room-status.mjs).
// Without one, Construct reads the issue ids in the room name instead.
//
//   construct-issue BEN-359 [BEN-364 …] [--room !id]
//   construct-issue --clear [--room !id]
//
// --room defaults to $AGENT_ROOM_ID, set for every agent turn.
// Installed as ~/.local/bin/construct-issue (a symlink here).

const args = process.argv.slice(2)
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: construct-issue BEN-123 [BEN-124 …] [--room !id]\n       construct-issue --clear [--room !id]')
  process.exit(args.length ? 0 : 1)
}
let roomId = process.env.AGENT_ROOM_ID
const r = args.indexOf('--room')
if (r >= 0) {
  roomId = args[r + 1]
  if (!roomId || roomId.startsWith('--')) die('--room needs a value')
  args.splice(r, 2)
}
const clear = args.includes('--clear')
const issues = args.filter((a) => a !== '--clear').flatMap((a) => a.split(/[\s,+]+/)).filter(Boolean)
if (clear && issues.length) die('Give issue ids or --clear, not both.')
if (!clear && !issues.length) die('Give an issue id, e.g. BEN-123, or --clear.')
const bad = issues.filter((k) => !/^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,6}$/.test(k))
if (bad.length) die(`Not issue ids: ${bad.join(' ')}`)
if (!roomId) die('No room: pass --room !id (AGENT_ROOM_ID is not set).')

const port = Number(process.env.AGENT_APPROVAL_PORT ?? 8787)
let res
try {
  res = await fetch(`http://127.0.0.1:${port}/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, issues }),
  })
} catch (e) {
  die(`The bot is not reachable on 127.0.0.1:${port} (${e.message}).`)
}
if (!res.ok) die(`The bot could not set it (${res.status}): ${await res.text()}`)
const { issues: set } = await res.json().catch(() => ({ issues }))
console.log(set?.length ? `${roomId} is working on ${set.join(' ')}` : `Cleared the issue for ${roomId}`)

function die(msg) {
  console.error(msg)
  process.exit(1)
}
