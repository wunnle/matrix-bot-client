#!/usr/bin/env node
// Sets or updates the plan of the agent room a turn runs in, which Construct's
// side panel shows (scripts/room-plan.mjs). Prints the plan as it now stands.
//
//   construct-plan "Read the hook code" "Publish the phase" "Ship"   a new plan
//   construct-plan --done 2 [3]     steps finished; the next one starts
//   construct-plan --now 3          step 3 is under way
//   construct-plan --add "Step" …   more steps at the end
//   construct-plan --clear          no plan
//
// --room !id defaults to $AGENT_ROOM_ID, set for every agent turn.
// Installed as ~/.local/bin/construct-plan (a symlink here).
import { formatPlan } from './room-plan.mjs'

const USAGE = `Usage: construct-plan "Step one" "Step two" …
       construct-plan --done N [N …] | --now N | --add "Step" … | --clear
       [--room !id]`

const args = process.argv.slice(2)
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(args.length ? 0 : 1)
}
let roomId = process.env.AGENT_ROOM_ID
const r = args.indexOf('--room')
if (r >= 0) {
  roomId = args[r + 1]
  if (!roomId || roomId.startsWith('--')) die('--room needs a value')
  args.splice(r, 2)
}
if (!roomId) die('No room: pass --room !id (AGENT_ROOM_ID is not set).')

const flags = args.filter((a) => /^--(done|now|add|clear)$/.test(a))
if (flags.length > 1) die('One change at a time: --done, --now, --add or --clear.')
const rest = args.filter((a) => !flags.includes(a))
let op
switch (flags[0]) {
  case '--clear':
    if (rest.length) die('--clear takes nothing else.')
    op = { clear: true }
    break
  case '--done':
  case '--now': {
    const ns = rest.flatMap((a) => a.split(/[\s,]+/)).filter(Boolean).map(Number)
    if (!ns.length || ns.some((n) => !Number.isInteger(n) || n < 1)) die(`${flags[0]} takes step numbers, e.g. ${flags[0]} 2`)
    if (flags[0] === '--now' && ns.length > 1) die('--now takes one step number.')
    op = flags[0] === '--done' ? { done: ns } : { now: ns[0] }
    break
  }
  case '--add':
    if (!rest.length) die('--add takes the steps to add.')
    op = { add: rest }
    break
  default:
    if (rest.some((a) => a.startsWith('--'))) die(`Unknown option.\n${USAGE}`)
    op = { set: rest }
}

const port = Number(process.env.AGENT_APPROVAL_PORT ?? 8787)
let res
try {
  res = await fetch(`http://127.0.0.1:${port}/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, op }),
  })
} catch (e) {
  die(`The bot is not reachable on 127.0.0.1:${port} (${e.message}).`)
}
const body = await res.json().catch(() => ({}))
if (!res.ok) die(`The plan was not changed: ${body.error ?? res.status}`)
console.log(formatPlan(body.steps ?? []))

function die(msg) {
  console.error(msg)
  process.exit(1)
}
