#!/usr/bin/env node
// Set what the Construct home-screen widget shows on Sinan's phone. Each board
// has an id; a widget on the home screen is set to one board (long-press it →
// Edit Widget → Board), so "discord" and "linear" can be separate widgets.
//
//   construct-widget set   --id ID [--title T] [--tile ...] [--line ...] [options]
//   construct-widget clear --id ID
//   construct-widget list
//
// set only changes what it's given; the rest of the board stays.
//
// Options:
//   --title T                     the board's heading (with its tone's dot)
//   --tone neutral|success|warning|error
//   --tile "icon|value|sub|tone"  a tile (repeat, up to 4, drawn in order): icon
//                                 is an SF Symbol name (bubble.left.fill…) or a
//                                 bundled logo ("linear", "discord"); sub and
//                                 tone optional (tone tints sub). The small
//                                 widget draws the first 2, medium all 4.
//   --no-tiles                    remove the tiles
//   --line "text"                 a line under the tiles (repeat, up to 3; the
//                                 medium widget has room for them, small for 1)
//   --no-lines                    remove the lines
//   --room !id | none             tapping the widget opens this room
//                                 (default: $AGENT_ROOM_ID on a new board)
//
// The phone reloads widgets on iOS's schedule (about every 15 minutes) and when
// the app opens, so a change shows up then, not instantly. For something that
// needs Sinan now, use construct-activity.
//
// Installed as ~/.local/bin/construct-widget (a symlink here). Talks to
// /api/widget with CONSTRUCT_INTENT_SECRET from ~/.hermes/.env, which never
// appears on the command line. Prints the server's JSON reply; exits non-zero
// when the call failed.
import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'

const API = process.env.CONSTRUCT_WIDGET_API ?? 'https://construct.kafagoz.com/api/widget'
const ENV_FILE = `${os.homedir()}/.hermes/.env`

function die(message) {
  console.error(`construct-widget: ${message}`)
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

const [command, ...rest] = process.argv.slice(2)
if (!command || command === '-h' || command === '--help') {
  // The header comment is the help text, up to the paragraph about installation.
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1)
  const header = lines.slice(0, lines.findIndex((l) => !l.startsWith('//') || l.startsWith('// Installed')))
  console.log(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n').trimEnd())
  process.exit(command ? 0 : 2)
}
if (!['set', 'clear', 'list'].includes(command)) die(`unknown command "${command}" (set, clear, list)`)

let values
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      title: { type: 'string' },
      tone: { type: 'string' },
      tile: { type: 'string', multiple: true },
      'no-tiles': { type: 'boolean' },
      line: { type: 'string', multiple: true },
      'no-lines': { type: 'boolean' },
      room: { type: 'string' },
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

if (command === 'clear') {
  body.clear = true
} else {
  for (const key of ['title', 'tone']) {
    if (values[key] !== undefined) body[key] = values[key]
  }
  if (values['no-tiles']) body.tiles = null
  else if (values.tile) {
    body.tiles = values.tile.map((t) => {
      const [icon, value, sub, tone] = t.split('|').map((s) => s.trim())
      return { icon, value, ...(sub ? { sub } : {}), ...(tone ? { tone } : {}) }
    })
  }
  if (values['no-lines']) body.lines = null
  else if (values.line) body.lines = values.line
  if (values.room !== undefined) body.room = values.room === 'none' ? null : values.room
  else if (process.env.AGENT_ROOM_ID) {
    // Only a board that doesn't exist yet takes the agent room by default, so
    // a routine update from another room doesn't re-point the tap.
    const r = await fetch(`${API}?id=${encodeURIComponent(values.id)}`, { headers })
    const existing = await r.json().catch(() => null)
    if (r.ok && !existing?.board) body.room = process.env.AGENT_ROOM_ID
  }
}

const r = await fetch(API, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const reply = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
console.log(JSON.stringify(reply))
process.exit(r.ok ? 0 : 1)
