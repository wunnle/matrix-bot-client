#!/usr/bin/env node
// Opens a web page beside the chat: in the Browser tab of the room's side
// panel in Construct (src/components/BrowserPanel.tsx). Posts a card into the
// room, which Construct opens at once on a wide screen and keeps as the room's
// page; on the phone it stays a card to tap.
//
//   construct-browse <url> [--title T] [--room !id]
//
// The page is shown on Sinan's phone or Mac, not on the Pi: localhost there is
// that device. For a dev server on the Pi, use construct-preview <port>.
// --room defaults to $AGENT_ROOM_ID, set for every Claude agent turn.
import { browserUrl } from './browser-cards.mjs'

const args = process.argv.slice(2)
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: construct-browse <url> [--title T] [--room !id]')
  process.exit(args.length ? 0 : 1)
}
const flag = (name) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (!v || v.startsWith('--')) die(`${name} needs a value`)
  args.splice(i, 2)
  return v
}
const title = flag('--title') ?? ''
const roomId = flag('--room') ?? process.env.AGENT_ROOM_ID
if (args.length !== 1) die('Give exactly one URL.')
const url = browserUrl(args[0])
if (!url) die(`Not an http(s) URL: ${args[0]}`)
if (!roomId) die('No room: pass --room !id (AGENT_ROOM_ID is not set).')

const { hostname } = new URL(url)
if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(hostname)) {
  die(`${url} is localhost, which on Sinan's phone or Mac is that device, not this Pi. For a dev server here, use construct-preview <port>.`)
}

const port = Number(process.env.AGENT_APPROVAL_PORT ?? 8787)
let res
try {
  res = await fetch(`http://127.0.0.1:${port}/browse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, url, title }),
  })
} catch (e) {
  die(`The bot is not reachable on 127.0.0.1:${port} (${e.message}).`)
}
if (!res.ok) die(`The bot could not open it (${res.status}): ${await res.text()}`)
console.log(`Opened ${url} beside the chat in ${roomId}`)

function die(msg) {
  console.error(msg)
  process.exit(1)
}
