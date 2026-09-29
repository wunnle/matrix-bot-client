#!/usr/bin/env node
// Start, update and end Live Activities on Sinan's phone — the channel bots use
// to notify him actionably (buttons post a message back into a room).
//
//   construct-activity start  --id ID --title T [--body B] [--room !id] [options]
//   construct-activity update --id ID [--title T] [--body B] [options]
//   construct-activity end    --id ID [--body B] [--tone T] [--dismiss-in SECS]
//   construct-activity list
//
// Options:
//   --tone neutral|success|warning|error
//   --progress 0..1 | none        --step "3/5" | none
//   --action "Label" | "Label=text to send"   (repeat, up to 3)
//   --no-actions                  remove the buttons
//   --tile "icon|value|sub|tone"  a tile (repeat, up to 2): icon is an SF Symbol
//                                 name (sun.max.fill, moon.zzz.fill…); sub and
//                                 tone optional. Tiles switch the card to the
//                                 tile layout: tiles, then 2 body lines.
//   --no-tiles                    back to the normal layout
//   --countdown 10m | 90s | 1h30m show a countdown ending that far from now
//   --until 18:30 | ISO | none    show a countdown to a time (next 18:30, local)
//   --alert none|quiet|loud       (start: quiet by default; updates: none)
//   --ttl SECS                    lifetime, default 3600, max 28800; it only
//                                 dims and removes the card, it's not shown
//
// --room defaults to $AGENT_ROOM_ID, set for every Claude agent turn. A button
// tap arrives in that room as a message tagged com.construct.activity_id.
//
// Installed as ~/.local/bin/construct-activity (a symlink here). Talks to
// /api/activity with CONSTRUCT_INTENT_SECRET from ~/.hermes/.env, which never
// appears on the command line. Prints the server's JSON reply; exits non-zero
// when the call failed.
import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'

const API = process.env.CONSTRUCT_API ?? 'https://construct.kafagoz.com/api/activity'
const ENV_FILE = `${os.homedir()}/.hermes/.env`

function die(message) {
  console.error(`construct-activity: ${message}`)
  process.exit(2)
}

function secret() {
  let text
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8')
  } catch {
    die(`cannot read ${ENV_FILE}`)
  }
  const value = text.match(/^CONSTRUCT_INTENT_SECRET=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
  if (!value) die(`CONSTRUCT_INTENT_SECRET is not set in ${ENV_FILE}`)
  return value
}

/** "90s", "10m", "1h30m", or bare seconds → seconds. */
function parseDuration(text) {
  if (/^\d+$/.test(text)) return Number(text)
  const m = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!m || !text) die(`--countdown must look like 90s, 10m or 1h30m, not "${text}"`)
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)
}

/** "18:30" (the next one, local time), an ISO date, unix seconds, or "none"
    to clear. The server checks it's in the future and within 8 hours. */
function parseUntil(text) {
  if (text === 'none') return null
  if (/^\d+$/.test(text)) return Number(text)
  const hm = text.match(/^(\d{1,2}):(\d{2})$/)
  if (hm) {
    const at = new Date()
    at.setHours(Number(hm[1]), Number(hm[2]), 0, 0)
    if (at <= new Date()) at.setDate(at.getDate() + 1)
    return Math.floor(at.getTime() / 1000)
  }
  if (Number.isNaN(Date.parse(text))) die(`--until must be HH:MM, an ISO date, unix seconds or none, not "${text}"`)
  return text
}

const [command, ...rest] = process.argv.slice(2)
if (!command || command === '-h' || command === '--help') {
  // The header comment is the help text, up to the paragraph about installation.
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1)
  const header = lines.slice(0, lines.findIndex((l) => !l.startsWith('//') || l.startsWith('// Installed')))
  console.log(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n').trimEnd())
  process.exit(command ? 0 : 2)
}
if (!['start', 'update', 'end', 'list'].includes(command)) die(`unknown command "${command}" (start, update, end, list)`)

let values
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      room: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      tone: { type: 'string' },
      progress: { type: 'string' },
      step: { type: 'string' },
      action: { type: 'string', multiple: true },
      'no-actions': { type: 'boolean' },
      tile: { type: 'string', multiple: true },
      'no-tiles': { type: 'boolean' },
      alert: { type: 'string' },
      countdown: { type: 'string' },
      until: { type: 'string' },
      ttl: { type: 'string' },
      'dismiss-in': { type: 'string' },
    },
  }))
} catch (e) {
  die(e.message)
}

const headers = { 'x-intent-secret': secret() }

if (command === 'list') {
  const r = await fetch(API, { headers })
  console.log(JSON.stringify(await r.json().catch(() => ({ error: `HTTP ${r.status}` }))))
  process.exit(r.ok ? 0 : 1)
}

if (!values.id) die('--id is required')
const body = { id: values.id }
for (const key of ['title', 'body', 'tone', 'alert']) {
  if (values[key] !== undefined) body[key] = values[key]
}
for (const key of ['progress', 'step']) {
  const v = values[key]
  if (v === undefined) continue
  body[key] = v === 'none' ? null : key === 'progress' ? Number(v) : v
}
if (values.ttl !== undefined) body.ttl = Number(values.ttl)
if (values.countdown !== undefined && values.until !== undefined) die('use --countdown or --until, not both')
if (values.countdown !== undefined) body.until = Math.floor(Date.now() / 1000) + parseDuration(values.countdown)
if (values.until !== undefined) body.until = parseUntil(values.until)
if (values['no-actions']) body.actions = []
else if (values.action) {
  body.actions = values.action.map((a) => {
    const i = a.indexOf('=')
    return i === -1 ? { label: a } : { label: a.slice(0, i), send: a.slice(i + 1) }
  })
}

if (values['no-tiles']) body.tiles = null
else if (values.tile) {
  body.tiles = values.tile.map((t) => {
    const [icon, value, sub, tone] = t.split('|').map((s) => s.trim())
    return { icon, value, ...(sub ? { sub } : {}), ...(tone ? { tone } : {}) }
  })
}

if (command === 'start') {
  body.room = values.room ?? process.env.AGENT_ROOM_ID
  if (!body.room) die('--room is required outside an agent room')
  if (!body.title) die('--title is required to start')
} else if (values.room) {
  die('--room only applies to start')
}
if (command === 'end') {
  body.end = true
  if (values['dismiss-in'] !== undefined) body.dismissIn = Number(values['dismiss-in'])
}

const r = await fetch(API, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const reply = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
// An update to an id that isn't running reads, server-side, as a start without
// a title. Say what actually happened.
if (command === 'update' && r.status === 400 && /missing (title|room)/.test(reply.error ?? '')) {
  reply.error = `no running activity "${values.id}" (use start)`
}
console.log(JSON.stringify(reply))
process.exit(r.ok && reply.ok !== false ? 0 : 1)
