#!/usr/bin/env node
// The Discord room service: owns the Discord room, shows what on Sinan's work
// Discord needs him, and keeps the list he marks as pending. No LLM anywhere.
//
// The data comes from the Pi's Discord collector (~/.hermes/scripts/
// discord_digest.py, cron every 5 min), which this only reads through its CLI.
// What the room adds — pending items and Done taps — lives in
// ~/.hermes/state/discord/room.json, which the collector reads back, so Done
// here also clears the morning card and digest.
//
// The room-view contract (as the Watchlist's):
//   declare  m.room.create-time state `com.construct.room_view` = {kind: 'discord'}
//   read     `com.construct.discord` room state: {needs, pending, seen, threads, syncedAt}
//   act      Construct sends `com.construct.discord.action` events
//            ({action: pend|unpend|done|undone, id}); each is answered by an
//            m.notice carrying `com.construct.discord.result`
//   add      a Discord message link typed in the room (plus an optional note)
//            becomes a pending item
//
// Runs as @bender-2 on its OWN device, like the watchlist service: sharing
// another client's token would steal its to-device messages. The room is
// unencrypted, so this client needs no crypto.
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const HOMESERVER = process.env.HOMESERVER ?? 'https://matrix.org'
const USER_ID = process.env.USER_ID_B
const PASSWORD = process.env.PASSWORD_B
const OWNER_ID = process.env.AGENT_OWNER_ID ?? '@wunnle:matrix.org'
const CONFIG_DIR = process.env.DISCORD_ROOM_CONFIG ?? path.join(os.homedir(), '.config', 'discord-room')
const DATA_DIR = process.env.DISCORD_ROOM_DATA ?? path.join(os.homedir(), '.local', 'share', 'discord-room')
const DIGEST = process.env.DISCORD_DIGEST ?? path.join(os.homedir(), '.hermes', 'scripts', 'discord_digest.py')
const CACHE_DIR = process.env.DISCORD_DIGEST_DIR ?? path.join(os.homedir(), '.hermes', 'state', 'discord')
const ROOM_STORE = path.join(CACHE_DIR, 'room.json')
const CACHE_STATE = path.join(CACHE_DIR, 'state.json')
// Thread summaries, written by `discord_digest.py summarize` (cron, 10 min).
const SUMMARIES = path.join(CACHE_DIR, 'summaries.json')
const THREADS_MAX = 15

// Keep in sync with Construct's DiscordView.
const ROOM_VIEW_EVENT = 'com.construct.room_view'
const STATE_EVENT = 'com.construct.discord'
const ACTION_EVENT = 'com.construct.discord.action'
const RESULT_KEY = 'com.construct.discord.result'

// How far back "needs you" reaches, and how long seen/answered alerts linger
// so one can still be kept as pending.
const NEEDS_SINCE = '7d'
const SEEN_FOR_MS = 48 * 60 * 60 * 1000
const SEEN_MAX = 15
const DONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
// The collector writes every 5 min; checking its file each minute is cheap.
const CHECK_MS = 60 * 1000
const SYNCED_EVERY_MS = 15 * 60 * 1000
// Long messages are cut in room state: Matrix caps an event at 64 KiB.
const CONTENT_MAX = 700
const STATE_WARN_BYTES = 48 * 1024

if (!USER_ID || !PASSWORD) {
  console.error('Missing USER_ID_B or PASSWORD_B in env')
  process.exit(1)
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}][discord-room]`, ...args)
}

fs.mkdirSync(CONFIG_DIR, { recursive: true })
fs.mkdirSync(DATA_DIR, { recursive: true })
const sessionFile = path.join(CONFIG_DIR, 'session.json')
const roomFile = path.join(CONFIG_DIR, 'room.json')
const syncFile = path.join(DATA_DIR, 'sync.json')
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const writePrivate = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })

// --- The collector ---

const run = promisify(execFile)

async function digest(...args) {
  const { stdout } = await run('python3', [DIGEST, ...args], { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(stdout)
}

/** The room's own list. Written atomically: the collector reads it on every pass. */
function loadStore() {
  const s = readJson(ROOM_STORE) ?? {}
  return { pending: s.pending ?? {}, done: s.done ?? {} }
}

function saveStore(store) {
  const cutoff = Date.now() - DONE_KEEP_MS
  for (const [id, at] of Object.entries(store.done)) if (at < cutoff) delete store.done[id]
  const tmp = `${ROOM_STORE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1))
  fs.renameSync(tmp, ROOM_STORE)
}

/** What a card needs, and no more: room state is size-capped. */
function slim(r) {
  const content = r.content ?? ''
  return {
    id: r.id,
    ts: r.ts,
    author: r.author,
    channel: r.channel_name,
    thread: r.thread_name ?? null,
    content: content.length > CONTENT_MAX ? `${content.slice(0, CONTENT_MAX - 1)}…` : content,
    replyTo: r.reply_to ? { author: r.reply_to.author, content: (r.reply_to.content ?? '').slice(0, 160) } : null,
    attachments: r.attachments ?? [],
    url: r.url,
    reasons: r.alert ?? [],
    ack: r.ack ?? null,
    answered: Boolean(r.answered),
  }
}

// --- Matrix client-server API, by hand (see watchlist/service.mjs) ---

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
    initial_device_display_name: 'construct discord room',
  })
  token = access_token
  writePrivate(sessionFile, { access_token, device_id })
  log(`logged in as ${USER_ID}, device ${device_id}`)
}

async function ensureRoom() {
  const saved = readJson(roomFile)
  if (saved?.roomId) return saved.roomId
  const { room_id } = await api('POST', '/createRoom', {
    name: 'Discord',
    topic: 'What on Discord needs you. Paste a message link to keep it pending.',
    preset: 'private_chat',
    invite: [OWNER_ID],
    // No m.room.encryption: this client has no crypto.
    initial_state: [{ type: ROOM_VIEW_EVENT, state_key: '', content: { kind: 'discord' } }],
    // Room v12 rejects the creator in this list; only the owner goes in.
    power_level_content_override: { users: { [OWNER_ID]: 100 } },
  })
  writePrivate(roomFile, { roomId: room_id })
  log(`created the Discord room ${room_id} and invited ${OWNER_ID}`)
  return room_id
}

// --- State and replies ---

let lastPublished = null
let alerts = []

// Matrix events are canonical JSON: integers only (see watchlist/service.mjs).
const noFloats = (_key, value) => (typeof value === 'number' && !Number.isInteger(value) ? String(value) : value)

async function readAlerts() {
  alerts = await digest('alerts', '--since', NEEDS_SINCE, '--json')
}

function view() {
  const store = loadStore()
  const byId = new Map(alerts.map((r) => [r.id, r]))
  const needs = alerts
    .filter((r) => !r.answered && !r.ack && !store.done[r.id] && !store.pending[r.id])
    .reverse()
  // A pending item shows its latest record when the alert is still in the
  // window, so a reaction or reply made since shows on it.
  const pending = Object.values(store.pending)
    .filter((p) => !store.done[p.record.id])
    .sort((a, b) => b.at - a.at)
    .map((p) => ({ ...slim(byId.get(p.record.id) ?? p.record), note: p.note ?? null, pendingAt: p.at }))
  const recent = Date.now() - SEEN_FOR_MS
  const seen = alerts
    .filter((r) => (r.ack === 'seen' || r.answered) && !store.pending[r.id] && !store.done[r.id]
      && Date.parse(r.ts) > recent)
    .reverse()
    .slice(0, SEEN_MAX)
  // What's going on elsewhere: every thread active in the last day, newest
  // first, with its summary once `summarize` has written one.
  const threads = Object.values(readJson(SUMMARIES) ?? {})
    .sort((a, b) => Date.parse(b.last_ts) - Date.parse(a.last_ts))
    .slice(0, THREADS_MAX)
    .map((t) => ({
      id: t.id,
      channel: t.channel,
      thread: t.thread ?? null,
      topic: t.topic ?? null,
      summary: t.summary ?? null,
      status: t.status ?? null,
      count: t.count,
      people: t.people ?? [],
      lastTs: t.last_ts,
      url: t.url,
    }))
  return {
    version: 1,
    needs: needs.map(slim),
    pending,
    seen: seen.map(slim),
    threads,
    syncedAt: readJson(CACHE_STATE)?.synced ?? null,
  }
}

let lastPublishedAt = 0

async function publish(roomId) {
  const content = JSON.parse(JSON.stringify({ ...view(), updatedAt: Date.now() }, noFloats))
  // The lists decide; syncedAt alone moves every 5 min and would put a state
  // event in the room each time, so it only republishes every SYNCED_EVERY_MS.
  const { updatedAt: _u, syncedAt: _s, ...rest } = content
  const fingerprint = JSON.stringify(rest)
  if (fingerprint === lastPublished && Date.now() - lastPublishedAt < SYNCED_EVERY_MS) return
  const bytes = Buffer.byteLength(JSON.stringify(content))
  if (bytes > STATE_WARN_BYTES) log(`⚠️ discord state is ${bytes} bytes, nearing Matrix's 64 KiB event cap`)
  await api('PUT', `/rooms/${encodeURIComponent(roomId)}/state/${STATE_EVENT}/`, content)
  lastPublished = fingerprint
  lastPublishedAt = Date.now()
  log(`published ${content.needs.length} needing you, ${content.pending.length} pending, ${content.seen.length} seen, ${content.threads.length} threads`)
}

let txn = 0
async function notice(roomId, text, result) {
  const content = { msgtype: 'm.notice', body: text, ...(result && { [RESULT_KEY]: result }) }
  await api('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/dr${Date.now()}-${txn++}`, content)
}

const label = (r) => {
  const text = (r.content ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  const short = text.length > 60 ? `${text.slice(0, 59)}…` : text
  return `${r.author} in ${r.thread_name ?? r.thread ?? `#${r.channel_name ?? r.channel}`}${short ? `: ${short}` : ''}`
}

// --- Actions ---

function findRecord(id, store) {
  return alerts.find((r) => r.id === id) ?? store.pending[id]?.record ?? null
}

const handlers = {
  pend: ({ id }) => {
    const store = loadStore()
    const record = findRecord(id, store)
    if (!record) throw new Error('That message is no longer in the list.')
    store.pending[id] = { record, at: Date.now(), note: store.pending[id]?.note ?? null }
    delete store.done[id]
    saveStore(store)
    return `📌 Pending: ${label(record)}`
  },
  unpend: ({ id }) => {
    const store = loadStore()
    const item = store.pending[id]
    if (!item) throw new Error('Not pending.')
    delete store.pending[id]
    saveStore(store)
    return `No longer pending: ${label(item.record)}`
  },
  done: ({ id }) => {
    const store = loadStore()
    const record = findRecord(id, store)
    delete store.pending[id]
    store.done[id] = Date.now()
    saveStore(store)
    return `✓ Done${record ? `: ${label(record)}` : ''}`
  },
  undone: ({ id }) => {
    const store = loadStore()
    delete store.done[id]
    saveStore(store)
    const record = findRecord(id, store)
    return `Back on the list${record ? `: ${label(record)}` : ''}`
  },
}

async function handleAction(roomId, event) {
  const { action, id, request_id: requestId } = event.content ?? {}
  const handler = handlers[action]
  let result
  if (!handler || typeof id !== 'string') {
    result = { ok: false, message: `Unknown action: ${action}` }
  } else {
    try {
      result = { ok: true, message: await handler({ id }) }
    } catch (err) {
      result = { ok: false, message: err.message }
    }
  }
  log(`${action} ${id ?? ''} → ${result.ok ? 'ok' : 'failed'}: ${result.message}`)
  await publish(roomId)
  await notice(roomId, result.ok ? result.message : `⚠️ ${result.message}`, { request_id: requestId ?? null, action, id: id ?? null, ...result })
}

// --- Adding: a Discord message link, with anything else typed as its note ---

const LINK = /https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+/

async function handleText(roomId, body) {
  const link = body.match(LINK)?.[0]
  if (!link) {
    return notice(roomId, 'Paste a Discord message link (Copy Message Link) to keep it pending. Anything else you type goes in as its note.')
  }
  const note = body.replace(link, '').replace(/\s+/g, ' ').trim() || null
  let record
  try {
    record = await digest('message', link)
  } catch (err) {
    const reason = (() => { try { return JSON.parse(err.stdout).error } catch { return err.message } })()
    log(`add ${link} failed: ${reason}`)
    return notice(roomId, `⚠️ Couldn't read that message: ${reason}`, { action: 'pend', id: null, ok: false })
  }
  const store = loadStore()
  const already = Boolean(store.pending[record.id])
  store.pending[record.id] = { record, at: Date.now(), note: note ?? store.pending[record.id]?.note ?? null }
  delete store.done[record.id]
  saveStore(store)
  log(`add ${record.id} → ${already ? 'updated' : 'pending'}`)
  await publish(roomId)
  await notice(roomId, `${already ? 'Already pending' : '📌 Pending'}: ${label(record)}${note ? `\nNote: ${note}` : ''}`,
    { action: 'pend', id: record.id, ok: true })
}

async function handleEvent(roomId, event) {
  if (event.sender !== OWNER_ID) return
  if (event.type === ACTION_EVENT) return handleAction(roomId, event)
  if (event.type === 'm.room.message' && event.content?.msgtype === 'm.text' && typeof event.content.body === 'string') {
    return handleText(roomId, event.content.body)
  }
}

// --- Keeping up with the collector ---

let lastMtime = 0
let checking = false

async function check(roomId, force = false) {
  if (checking) return
  checking = true
  try {
    const mtime = Math.max(...[CACHE_STATE, ROOM_STORE, SUMMARIES].map((f) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }))
    if (!force && mtime === lastMtime) return
    lastMtime = mtime
    await readAlerts()
    await publish(roomId)
  } catch (err) {
    log(`refresh failed: ${err.message}`)
  } finally {
    checking = false
  }
}

// --- Sync loop ---

async function main() {
  await login()
  const roomId = await ensureRoom()
  await check(roomId, true)

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

  let since = readJson(syncFile)?.since ?? null
  if (!since) {
    since = (await api('GET', '/sync', undefined, { query: { filter: filter.filter_id, timeout: 0 } })).next_batch
    writePrivate(syncFile, { since })
  }
  log(`listening in ${roomId}`)

  setInterval(() => check(roomId), CHECK_MS)

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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
