#!/usr/bin/env node
// The watchlist service: owns the Watchlist room, keeps the list, and answers
// what Construct and the owner send there. No LLM anywhere in it.
//
// The room-view contract (first instance — see BEN-304):
//   declare  m.room.create-time state `com.construct.room_view` = {kind: 'watchlist'}
//   read     `com.construct.watchlist` room state holds the whole list
//   act      Construct sends `com.construct.watchlist.action` events; each one
//            is answered by an m.notice carrying `com.construct.watchlist.result`
//
// Runs as @bender-2 on its OWN device. The Claude bot uses Rust crypto on its
// device, and to-device messages (megolm keys) are deleted once any client
// syncing that device acknowledges them — sharing its token would quietly steal
// the bot's room keys. The room is unencrypted, so this client needs no crypto.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createStore } from './store.mjs'
import { choiceLabel, cinemetaMeta, enrich, needsPopularity, parseInput, pickCandidate, searchCinemeta, withPopularity } from './lookup.mjs'

const HOMESERVER = process.env.HOMESERVER ?? 'https://matrix.org'
const USER_ID = process.env.USER_ID_B
const PASSWORD = process.env.PASSWORD_B
const OWNER_ID = process.env.AGENT_OWNER_ID ?? '@wunnle:matrix.org'
const CONFIG_DIR = process.env.WATCHLIST_CONFIG ?? path.join(os.homedir(), '.config', 'watchlist')
const DATA_DIR = process.env.WATCHLIST_DATA ?? path.join(os.homedir(), '.local', 'share', 'watchlist')

// Keep in sync with Construct's watchlist view (BEN-305).
const ROOM_VIEW_EVENT = 'com.construct.room_view'
const STATE_EVENT = 'com.construct.watchlist'
const ACTION_EVENT = 'com.construct.watchlist.action'
const RESULT_KEY = 'com.construct.watchlist.result'

// A Play tap that sat in the queue while the service was down must not switch
// the TV on hours later. List edits are still applied — they are what was asked.
const STALE_PLAY_MS = 2 * 60 * 1000
// Matrix caps an event at 64 KiB. Warn well before the list gets there.
const STATE_WARN_BYTES = 48 * 1024
// TMDB details go stale (new seasons, providers rotating in and out of TR);
// each title is looked up again once it is this old.
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const REFRESH_CHECK_MS = 60 * 60 * 1000
// How long a "which one?" set of buttons stays answerable.
const CHOICE_TTL_MS = 30 * 60 * 1000

if (!USER_ID || !PASSWORD) {
  console.error('Missing USER_ID_B or PASSWORD_B in env')
  process.exit(1)
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}][watchlist]`, ...args)
}

fs.mkdirSync(CONFIG_DIR, { recursive: true })
const sessionFile = path.join(CONFIG_DIR, 'session.json')
const roomFile = path.join(CONFIG_DIR, 'room.json')
const syncFile = path.join(DATA_DIR, 'sync.json')
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const writePrivate = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })

const store = createStore(DATA_DIR)

// --- Matrix client-server API, by hand: one room and a handful of calls do
// not justify matrix-js-sdk's sync engine. ---

let token = null

async function api(method, endpoint, body, { query, timeoutMs = 30000 } = {}) {
  const url = new URL(`${HOMESERVER}/_matrix/client/v3${endpoint}`)
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v)
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 429 && attempt < 3) {
      const wait = (await res.json().catch(() => ({}))).retry_after_ms ?? 1000 * 2 ** attempt
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(`${method} ${endpoint} → ${res.status} ${data.errcode ?? ''} ${data.error ?? ''}`), { status: res.status })
    return data
  }
}

async function login() {
  const saved = readJson(sessionFile)
  if (saved?.access_token) {
    token = saved.access_token
    try {
      await api('GET', '/account/whoami')
      return
    } catch (err) {
      if (err.status !== 401) throw err
      log('saved session is no longer valid, logging in again')
    }
  }
  token = null
  const { access_token, device_id } = await api('POST', '/login', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: USER_ID },
    password: PASSWORD,
    initial_device_display_name: 'construct watchlist',
  })
  token = access_token
  writePrivate(sessionFile, { access_token, device_id })
  log(`logged in as ${USER_ID}, device ${device_id}`)
}

async function ensureRoom() {
  const saved = readJson(roomFile)
  if (saved?.roomId) return saved.roomId
  const { room_id } = await api('POST', '/createRoom', {
    name: 'Watchlist',
    topic: 'Send a title or an IMDb link to add it.',
    preset: 'private_chat',
    invite: [OWNER_ID],
    // No m.room.encryption: this client has no crypto, and nothing here is secret.
    initial_state: [{ type: ROOM_VIEW_EVENT, state_key: '', content: { kind: 'watchlist' } }],
    // Only the owner: room v12 gives the creator unlimited power and rejects
    // a createRoom that lists it here ("Creator … must not appear in content.users").
    power_level_content_override: { users: { [OWNER_ID]: 100 } },
  })
  writePrivate(roomFile, { roomId: room_id })
  log(`created the Watchlist room ${room_id} and invited ${OWNER_ID}`)
  return room_id
}

// --- State and replies ---

let lastPublished = null

async function publish(roomId) {
  const content = { version: 1, items: store.list(), updatedAt: Date.now() }
  const fingerprint = JSON.stringify(content.items)
  if (fingerprint === lastPublished) return
  const bytes = Buffer.byteLength(JSON.stringify(content))
  if (bytes > STATE_WARN_BYTES) log(`⚠️ watchlist state is ${bytes} bytes, nearing Matrix's 64 KiB event cap`)
  await api('PUT', `/rooms/${encodeURIComponent(roomId)}/state/${STATE_EVENT}/`, content)
  lastPublished = fingerprint
  log(`published ${content.items.length} items`)
}

let txn = 0
async function notice(roomId, text, result) {
  const content = { msgtype: 'm.notice', body: text, ...(result && { [RESULT_KEY]: result }) }
  await api('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/wl${Date.now()}-${txn++}`, content)
}

// --- Actions ---

/**
 * One handler per action. Each returns the line to show; throwing reports a
 * failure. Adding is not an action: it comes in as a typed message (handleText).
 * `play` arrives with BEN-303.
 */
const handlers = {
  watched: ({ id }) => `✓ Watched: ${store.setWatched(id, true).title}`,
  unwatched: ({ id }) => `Back on the list: ${store.setWatched(id, false).title}`,
  remove: ({ id }) => `Removed: ${store.remove(id).title}`,
}

async function handleAction(roomId, event) {
  const { action, id, request_id: requestId } = event.content ?? {}
  const handler = handlers[action]
  const age = Date.now() - (event.origin_server_ts ?? 0)
  let result
  if (!handler) {
    result = { ok: false, message: `Unknown action: ${action}` }
  } else if (action === 'play' && age > STALE_PLAY_MS) {
    result = { ok: false, message: `Skipped a Play from ${Math.round(age / 60000)} min ago — tap it again.` }
  } else {
    try {
      result = { ok: true, message: await handler({ id, roomId }) }
    } catch (err) {
      result = { ok: false, message: err.message }
    }
  }
  log(`${action} ${id ?? ''} → ${result.ok ? 'ok' : 'failed'}: ${result.message}`)
  await publish(roomId)
  await notice(roomId, result.ok ? result.message : `⚠️ ${result.message}`, { request_id: requestId ?? null, action, id: id ?? null, ...result })
}

// --- Adding: anything the owner types in the room is a title or an IMDb link ---

/** label → candidate, for the buttons of the last "which one?" question. */
let choices = { expires: 0, byLabel: new Map() }

function whereText(item) {
  const names = { netflix: 'Netflix', hbomax: 'HBO Max', prime: 'Prime Video', apple: 'Apple TV+' }
  return item.providers?.length ? item.providers.map((k) => names[k] ?? k).join(', ') : 'Stremio'
}

function offer(candidates, replaces = null) {
  choices = {
    expires: Date.now() + CHOICE_TTL_MS,
    byLabel: new Map(candidates.map((c) => [choiceLabel(c), { ...c, replaces }])),
  }
  return [...choices.byLabel.keys()].map((l) => `[[${l}]]`).join(' ')
}

/**
 * @param fallback what search already knew, used when TMDB has nothing
 * @param others   same-named titles passed over by a popularity guess, offered as swaps
 */
async function addById(roomId, id, fallback = null, others = []) {
  let details = await enrich(id).catch((err) => { log(`TMDB lookup for ${id} failed: ${err.message}`); return null })
  details ??= fallback ?? await cinemetaMeta(id)
  if (!details) {
    return notice(roomId, `⚠️ Couldn't find ${id} on TMDB or Cinemeta.`, { action: 'add', id, ok: false })
  }
  const { item, added } = store.add({ ...details, id })
  log(`add ${id} → ${added ? 'added' : 'duplicate'}: ${item.title}`)
  await publish(roomId)
  const year = item.year ? ` (${item.year})` : ''
  const line = added ? `Added: ${item.title}${year} — ${whereText(item)}` : `Already on the list: ${item.title}${year}`
  // A guess says so, and puts the alternatives one tap away.
  const swap = added && others.length ? `\n\nNot this one?\n\n${offer(others, id)}` : ''
  await notice(roomId, line + swap, { action: 'add', id, ok: true, added })
}

async function handleText(roomId, body) {
  const chosen = Date.now() < choices.expires ? choices.byLabel.get(body.trim()) : null
  if (chosen) {
    choices = { expires: 0, byLabel: new Map() }
    if (chosen.replaces && store.get(chosen.replaces)) {
      store.remove(chosen.replaces)
      log(`swap ${chosen.replaces} → ${chosen.id}`)
    }
    return addById(roomId, chosen.id, chosen)
  }

  const input = parseInput(body)
  if (!input) return
  if (input.imdbId) return addById(roomId, input.imdbId)

  let candidates = await searchCinemeta(input.query)
  if (needsPopularity(input.query, candidates)) candidates = await withPopularity(input.query, candidates)
  const result = pickCandidate(input.query, candidates)
  if (result.none) {
    return notice(roomId, `Nothing found for “${input.query}”. An IMDb link always works.`, { action: 'add', id: null, ok: false })
  }
  if (result.pick) return addById(roomId, result.pick.id, result.pick, result.others)
  await notice(roomId, `Which “${input.query}”?\n\n${offer(result.choices)}`)
}

// --- Refreshing TMDB details ---

let refreshing = false

/** Looks up every title whose details are older than REFRESH_AFTER_MS. One at a time — there's no hurry. */
async function refreshStale(roomId) {
  if (refreshing) return
  refreshing = true
  try {
    const stale = store.list().filter((i) => Date.now() - (i.refreshedAt ?? 0) > REFRESH_AFTER_MS)
    if (!stale.length) return
    let changed = 0
    for (const item of stale) {
      try {
        const details = await enrich(item.id)
        if (details) {
          store.update(item.id, details)
          changed++
        } else {
          // Not on TMDB: don't ask again every hour.
          store.update(item.id, { refreshedAt: Date.now() })
        }
      } catch (err) {
        log(`refresh ${item.id} failed: ${err.message}`)
      }
    }
    log(`refreshed ${changed}/${stale.length} titles from TMDB`)
    await publish(roomId)
  } finally {
    refreshing = false
  }
}

async function handleEvent(roomId, event) {
  if (event.sender !== OWNER_ID) return
  if (event.type === ACTION_EVENT) return handleAction(roomId, event)
  if (event.type === 'm.room.message' && event.content?.msgtype === 'm.text' && typeof event.content.body === 'string') {
    return handleText(roomId, event.content.body)
  }
}

// --- Sync loop ---

async function run() {
  await login()
  const roomId = await ensureRoom()
  await publish(roomId)

  const filter = await api('POST', `/user/${encodeURIComponent(USER_ID)}/filter`, {
    presence: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
    room: {
      rooms: [roomId],
      timeline: { limit: 50, types: [ACTION_EVENT, 'm.room.message'] },
      state: { lazy_load_members: true, types: [] },
      ephemeral: { not_types: ['*'] },
      account_data: { not_types: ['*'] },
    },
  })

  // A saved token means events sent while we were down are still handled; a
  // first run starts from now rather than replaying the room's history.
  let since = readJson(syncFile)?.since ?? null
  if (!since) {
    since = (await api('GET', '/sync', undefined, { query: { filter: filter.filter_id, timeout: 0 } })).next_batch
    fs.mkdirSync(DATA_DIR, { recursive: true })
    writePrivate(syncFile, { since })
  }
  log(`listening in ${roomId}`)

  // Off the sync loop: a slow TMDB must never hold up an answer to a tap.
  const refresh = () => refreshStale(roomId).catch((err) => log(`refresh failed: ${err.message}`))
  refresh()
  setInterval(refresh, REFRESH_CHECK_MS)

  let backoff = 1000
  for (;;) {
    try {
      const data = await api('GET', '/sync', undefined, {
        query: { filter: filter.filter_id, since, timeout: 30000 },
        timeoutMs: 45000,
      })
      for (const event of data.rooms?.join?.[roomId]?.timeline?.events ?? []) {
        try {
          await handleEvent(roomId, event)
        } catch (err) {
          log(`failed on ${event.event_id}: ${err.message}`)
        }
      }
      since = data.next_batch
      writePrivate(syncFile, { since })
      backoff = 1000
    } catch (err) {
      log(`sync failed: ${err.message} — retrying in ${backoff / 1000}s`)
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 60000)
      if (err.status === 401) await login()
    }
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
