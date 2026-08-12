// Agent bot — each Matrix room is a persistent coding-agent session.
// Send `!spawn [path]` in any room it's in to create a fresh agent room. If a
// room already holds that repo, the new one gets its own git worktree.
// Which agent runs a room is the provider's business; see providers/index.mjs.
// Run: node --env-file=scripts/.env scripts/claude-code-bot.mjs
// Stop with Ctrl+C.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import { execFile } from 'node:child_process'
import { providerFor, resolveModel, allModelAliases, DEFAULT_PROVIDER, PROVIDERS } from './providers/index.mjs'

const STORE_DIR = path.resolve(import.meta.dirname, '.claude-bot-store')
fs.mkdirSync(STORE_DIR, { recursive: true })

const sdk = await import('matrix-js-sdk')
const { Marked } = await import('marked')
const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key.js')
const { calculateKeyCheck } = await import('matrix-js-sdk/lib/secret-storage.js')

const HOMESERVER = process.env.HOMESERVER
const USER_ID = process.env.USER_ID_C ?? process.env.USER_ID_B
const PASSWORD = process.env.PASSWORD_C ?? process.env.PASSWORD_B
// Who gets invited to spawned rooms. Deliberately NOT USER_ID — that is a bot
// account in this .env, not the human, so spawned rooms would invite a bot.
const OWNER_ID = process.env.AGENT_OWNER_ID ?? '@wunnle:matrix.org'
// cwd for rooms that were not spawned with an explicit path.
const DEFAULT_CWD = process.env.AGENT_CWD ?? path.join(os.homedir(), 'matrix-pwa')

// Which backend a room gets when it does not name one. AGENT_MODEL may name any
// provider's model; an unrecognised value falls back rather than being passed
// through to a CLI that would reject it.
const DEFAULT = resolveModel(process.env.AGENT_MODEL) ?? {
  provider: DEFAULT_PROVIDER,
  model: PROVIDERS[DEFAULT_PROVIDER].defaultModel,
}
const DEFAULT_MODEL = DEFAULT.model

// m.room.create `type` for rooms this bot spawns. Construct keys the standard
// action pills off this; keep it in sync with AGENT_ROOM_TYPE in src/lib/roomMeta.ts.
const AGENT_ROOM_TYPE = 'com.construct.agent'

// Survives a lost sessions.json, unlike the session map: the marker is in room
// state on the server. Mirrors isAgentRoom in src/lib/roomMeta.ts.
function isAgentRoom(roomId) {
  const create = client.getRoom(roomId)?.currentState?.getStateEvents('m.room.create', '')
  return create?.getContent()?.type === AGENT_ROOM_TYPE
}

// Loopback only — the broker decides what the agent may do, so it must not be
// reachable from anywhere but the hook running on this host.
const APPROVAL_PORT = Number(process.env.AGENT_APPROVAL_PORT ?? 8787)
const APPROVAL_TIMEOUT_MS = Number(process.env.AGENT_APPROVAL_TIMEOUT_MS ?? 10 * 60 * 1000)

if (!HOMESERVER || !USER_ID || !PASSWORD) {
  console.error('Missing HOMESERVER, USER_ID_C/USER_ID_B, or PASSWORD_C/PASSWORD_B in env')
  process.exit(1)
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}][claude-bot]`, ...args)
}

// roomId -> { sessionId, cwd, model, provider, … }. One agent session per room,
// forever. `provider` says which backend owns `sessionId`; entries written
// before providers existed have none and are read as Claude rooms.
const SESSIONS_FILE = path.join(STORE_DIR, 'sessions.json')
let sessions = {}
if (fs.existsSync(SESSIONS_FILE)) {
  try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) } catch {}
}
function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
}

// Persist session so we keep the same device_id across restarts.
// Otherwise every restart creates a new device, invalidating all megolm sessions.
const SESSION_FILE = path.join(STORE_DIR, '.session.json')

async function login() {
  log(`Logging in as ${USER_ID}…`)
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER_ID },
      password: PASSWORD,
      initial_device_display_name: 'construct claude-code-bot',
    }),
  })
  if (!res.ok) { console.error('Login failed:', await res.text()); process.exit(1) }
  const { access_token, device_id } = await res.json()
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ access_token, device_id }))
  return { access_token, device_id }
}

async function tokenValid(access_token) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { authorization: `Bearer ${access_token}` },
  })
  return res.ok
}

let access_token, device_id
if (fs.existsSync(SESSION_FILE)) {
  const stored = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
  if (await tokenValid(stored.access_token)) {
    log(`Reusing stored session (device: ${stored.device_id})`)
    access_token = stored.access_token
    device_id = stored.device_id
  } else {
    log('Stored token invalid, re-logging in')
  }
}
if (!access_token) {
  ;({ access_token, device_id } = await login())
  log(`device: ${device_id}`)
  // New device → wipe crypto store
  for (const f of fs.readdirSync(STORE_DIR)) {
    // Crypto state only. The room map and the room-number counter describe
    // rooms, not devices, and a reused number would collide with a live
    // worktree branch.
    if (!['.session.json', 'sessions.json', 'room-counter.json'].includes(f)) {
      fs.rmSync(path.join(STORE_DIR, f), { recursive: true, force: true })
    }
  }
}

process.chdir(STORE_DIR)
const dbManagerMod = await import('node-indexeddb/dbManager')
await dbManagerMod.default.loadCache().catch(() => {})
await import('node-indexeddb/auto')

function getCryptoStorageKey(userId, deviceId) {
  const input = `matrix-pwa:${userId}:${deviceId}`
  const key = new Uint8Array(32)
  for (let i = 0; i < input.length; i++) {
    key[i % 32] = (key[i % 32] * 31 + input.charCodeAt(i)) & 0xff
  }
  return key
}

const RECOVERY_KEY_STR = process.env.RECOVERY_KEY_C ?? process.env.RECOVERY_KEY_B ?? ''
let recoveryKeyBytes = null
if (RECOVERY_KEY_STR) {
  try { recoveryKeyBytes = decodeRecoveryKey(RECOVERY_KEY_STR) } catch {}
}

const client = sdk.createClient({
  baseUrl: HOMESERVER,
  accessToken: access_token,
  userId: USER_ID,
  deviceId: device_id,
  cryptoCallbacks: {
    getSecretStorageKey: async ({ keys }) => {
      if (!recoveryKeyBytes) return null
      for (const [keyId, info] of Object.entries(keys)) {
        if (!info?.iv || !info?.mac) continue
        try {
          const { mac } = await calculateKeyCheck(recoveryKeyBytes, info.iv)
          const norm = (s) => s.replace(/=+$/, '')
          if (norm(mac) === norm(info.mac)) return [keyId, recoveryKeyBytes]
        } catch {}
      }
      return null
    },
  },
})

log('Initialising crypto…')
await client.initRustCrypto({ storageKey: getCryptoStorageKey(USER_ID, device_id) })

log('Starting sync…')
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('sync timeout')), 30000)
  const onSync = (state) => {
    if (state === 'PREPARED' || state === 'SYNCING') {
      clearTimeout(timeout); client.off(sdk.ClientEvent.Sync, onSync); resolve()
    } else if (state === 'ERROR') {
      clearTimeout(timeout); client.off(sdk.ClientEvent.Sync, onSync); reject(new Error('sync failed'))
    }
  }
  client.on(sdk.ClientEvent.Sync, onSync)
  client.startClient({ lazyLoadMembers: true })
})

log('Ready. Joined rooms:')
client.getRooms().filter((r) => r.getMyMembership() === 'join').forEach((r) => {
  const s = sessions[r.roomId]
  log(`  ${r.roomId}  ${r.name}${s ? `  [${s.cwd} · ${s.model ?? DEFAULT_MODEL}]` : ''}`)
})

// Auto-accept invites
client.on(sdk.RoomEvent.MyMembership, async (room, membership) => {
  if (membership === 'invite') {
    log(`Invited to ${room.roomId} (${room.name}), joining…`)
    try {
      await client.joinRoom(room.roomId)
      log(`Joined ${room.roomId}`)
    } catch (e) {
      log(`Failed to join ${room.roomId}: ${e.message}`)
    }
  }
})

// Rooms that have asked to end and are awaiting confirmation. Ending is not
// reversible from chat, and !end sits next to !model on the pill row.
const pendingEnds = new Set()

// roomId -> { resolve, timer }. At most one outstanding approval per room:
// Claude is blocked inside the hook, so it cannot ask a second question.
const pendingApprovals = new Map()

// The hook reports its room directly (see AGENT_ROOM_ID below). Session-id
// lookup is only a fallback: a room's session id is not known until its first
// turn finishes, so during that first turn it would find nothing and deny.
function roomForRequest({ roomId, sessionId }) {
  if (roomId && sessions[roomId]) return roomId
  return Object.keys(sessions).find((id) => sessions[id].sessionId === sessionId)
}

// Resolves a room's outstanding approval, if any. Returns false when there was
// nothing pending, so the caller can treat the message as an ordinary prompt.
function settleApproval(roomId, decision, reason) {
  const pending = pendingApprovals.get(roomId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingApprovals.delete(roomId)
  pending.resolve({ decision, reason })
  return true
}

// Blocks the caller until the human answers in the room. Used by the Claude
// hook over loopback HTTP, and directly by providers that carry approvals on
// their own connection.
//
// `allowSession` offers a third answer, for backends that can remember a yes
// for the rest of the session. The Claude hook has no such notion, so its
// prompts stay two-way.
// `lang` tags the fenced block so Construct can colour it — 'diff' for file
// changes, absent for shell commands.
function askForApproval(roomId, { toolName, summary, lang, allowSession = false }) {
  return new Promise((resolve) => {
    // A second request for a room that is already waiting would strand the
    // first; refuse rather than lose track of it.
    if (pendingApprovals.has(roomId)) {
      resolve({ decision: 'deny', reason: 'Another approval is already pending in this room.' })
      return
    }

    const timer = setTimeout(() => {
      pendingApprovals.delete(roomId)
      sendRoomText(roomId,`⏱️ No answer — denied \`${toolName}\`.`).catch(() => {})
      resolve({ decision: 'deny', reason: 'Timed out waiting for approval.' })
    }, APPROVAL_TIMEOUT_MS)

    pendingApprovals.set(roomId, { resolve, timer })

    const buttons = allowSession
      ? '[[Approve]] [[Always allow]] [[Deny]]'
      : '[[Approve]] [[Deny]]'
    const body = `🔐 Approve \`${toolName}\`?\n\n${fencedBlock(summary, lang)}\n\n${buttons}`
    sendRoomText(roomId, body).catch((e) => {
      // If we can't ask, we must not proceed as though we had.
      settleApproval(roomId, 'deny', `Could not post the approval request: ${e.message}`)
    })
  })
}

// Construct reads com.construct.model off incoming messages and shows it in the
// chat header (see ChatView.tsx). Hermes tags its messages the same way, so
// agent rooms get the model indicator for free — including rooms spawned before
// the model was part of the room name.
function sendRoomText(roomId, text, extra = {}) {
  const model = sessions[roomId]?.model
  return client.sendMessage(roomId, {
    msgtype: 'm.text',
    body: text,
    format: 'org.matrix.custom.html',
    formatted_body: markdownToHtml(text),
    ...(model ? { 'com.construct.model': model } : {}),
    ...extra,
  })
}

// Claude Code answers in Markdown; Construct only renders rich text from
// formatted_body (ChatView reads it when format is org.matrix.custom.html) and
// otherwise prints the plain body verbatim, asterisks and all. The plain body
// stays as the fallback for clients that ignore the HTML.
//
// Raw HTML in the source is escaped rather than passed through, so a reply that
// discusses markup can't inject it. `[[Label]]` action markers survive as plain
// text — Construct turns them into buttons, and keeps them literal inside
// <code>, which is what we want for code blocks that happen to contain them.
// ```diff blocks are rendered line by line so Construct can colour additions
// and removals; Construct's sanitizer keeps exactly these class names. Any
// other language falls through to Marked's default code renderer.
function diffCode(token) {
  if (token.lang !== 'diff') return false
  const lines = String(token.text).split('\n').map((line) => {
    const cls = line.startsWith('+') ? 'diff-add'
      : line.startsWith('-') ? 'diff-del'
      : line.startsWith('#') ? 'diff-meta'
      : 'diff-ctx'
    // The marker gets its own span so it can sit off the code with a gap.
    // Unmarked lines carry an empty one, which keeps the columns aligned.
    const marked = cls !== 'diff-ctx'
    const mark = marked ? escapeHtml(line[0]) : ''
    const rest = escapeHtml(marked ? line.slice(1) : line) || '&nbsp;'
    return `<span class="${cls}"><span class="diff-mark">${mark}</span>${rest}</span>`
  })
  // Joined with nothing: the spans are display:block, so a newline between them
  // survives inside <pre> as its own line box and double-spaces the diff.
  return `<pre><code class="diff">${lines.join('')}</code></pre>`
}

const md = new Marked({
  renderer: {
    html: (token) => escapeHtml(token.raw),
    code: diffCode,
  },
})

function markdownToHtml(text) {
  return md.parse(String(text), { async: false }).trim()
}

// Fences `summary` as a Markdown code block, widening the fence so content
// containing backtick runs can't terminate it early.
function fencedBlock(summary, lang) {
  const longest = Math.max(0, ...[...String(summary).matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  // Never interpolate an untrusted language into the info string.
  const tag = /^[a-z]{1,12}$/.test(String(lang ?? '')) ? lang : ''
  return `${fence}${tag}\n${summary}\n${fence}`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function startApprovalBroker() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/approve')) {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      let payload
      try { payload = JSON.parse(raw) } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny', reason: 'Malformed approval request.' }))
        return
      }
      const roomId = roomForRequest(payload)
      if (!roomId) {
        // No room means no one to ask — the safe answer is no.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny', reason: 'No Matrix room is bound to this session.' }))
        return
      }
      log(`[${roomId}] approval requested: ${payload.toolName} — ${payload.summary}`)

      // If the hook goes away before the human answers — it aborted, or the
      // socket died — settle the room's pending approval instead of leaving it
      // stranded. A stranded entry rejects every later call in that room with
      // "Another approval is already pending", which reads as the agent being
      // wedged for no visible reason.
      let answered = false
      res.on('close', () => {
        if (!answered && settleApproval(roomId, 'deny', 'Approval client disconnected.')) {
          log(`[${roomId}] approval abandoned by client — pending entry cleared`)
        }
      })

      const result = await askForApproval(roomId, payload)
      answered = true
      log(`[${roomId}] approval ${result.decision}: ${payload.toolName}`)
      if (res.writableEnded) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    })
  })
  // A human may take minutes to answer, but Node's default requestTimeout (5
  // min) destroys the socket well before APPROVAL_TIMEOUT_MS (10 min). That gap
  // is what stranded entries: the hook saw "fetch failed" while the broker kept
  // waiting, blocking the room until its own timer expired.
  server.requestTimeout = APPROVAL_TIMEOUT_MS + 60_000
  server.headersTimeout = APPROVAL_TIMEOUT_MS + 60_000
  server.listen(APPROVAL_PORT, '127.0.0.1', () => {
    log(`Approval broker on 127.0.0.1:${APPROVAL_PORT}`)
  })
  server.on('error', (e) => {
    log(`Approval broker failed: ${e.message} — tool calls needing approval will be denied.`)
  })
}

// The first message usually already says what the room is for, so the agent is
// asked to retitle it from turn one and gets a second chance on turn two if the
// subject was still vague. Only while the name is still the auto-generated one —
// a name someone chose (or the agent already picked) is never revisited, so the
// ask stops as soon as it lands.
const RENAME_UNTIL_TURN = 2
const RENAME_INSTRUCTION =
  'This room is still using its placeholder name. If the subject of this ' +
  'conversation is now clear, invoke the room-rename skill to retitle it ' +
  'before you answer, and mention the new name in one short closing line. ' +
  'If it is not yet clear, skip it silently and just answer.'

// Construct renders trailing `[[Label]]` tokens as tappable buttons, so a turn
// that ends in a question is much cheaper to answer from a phone if it offers
// the likely replies. Applies to every turn, not just the first ones.
const QUICK_ANSWER_INSTRUCTION =
  'When your reply ends in a question or offers the user a choice, finish with ' +
  'two to four short quick-answer options in double-bracket notation on the ' +
  'last line, e.g. [[yes]] [[no]] [[restart service]]. Each label should be a ' +
  'few words at most and be a reply the user could plausibly send. Omit them ' +
  'when you are not asking anything.'

// Runs one turn through the room's provider, resuming its session if it has one.
// Everything provider-specific — how a turn is invoked, how instructions are
// injected, how the resumable id comes back — lives behind the adapter.
function runTurn(roomId, prompt) {
  const entry = sessions[roomId] ?? {
    sessionId: null, cwd: DEFAULT_CWD, model: DEFAULT_MODEL, provider: DEFAULT.provider,
  }
  const model = entry.model ?? DEFAULT_MODEL
  const provider = providerFor(entry)
  // Counted here rather than after the turn so a turn that crashes still moves
  // the count along; the nudge is best-effort and must not stick.
  entry.turns = (entry.turns ?? 0) + 1
  sessions[roomId] = entry
  saveSessions()

  // Room policy, not provider policy: what the agent should be told about this
  // room. The adapter decides where these end up.
  const instructions = [QUICK_ANSWER_INSTRUCTION]
  if (entry.turns <= RENAME_UNTIL_TURN && ROOM_NAME_RE.test(client.getRoom(roomId)?.name ?? '')) {
    instructions.push(RENAME_INSTRUCTION)
  }

  return provider.run({
    roomId,
    prompt,
    cwd: entry.cwd,
    model,
    sessionId: entry.sessionId,
    instructions,
    approval: {
      // For providers that gate through the loopback broker (Claude's hook).
      url: `http://127.0.0.1:${APPROVAL_PORT}/approve`,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      // For providers that carry approvals on their own connection and can ask
      // the room directly, skipping the HTTP hop entirely.
      ask: (request) => askForApproval(roomId, request),
    },
    // A turn can block on a human answering an approval, so this must exceed
    // the approval timeout rather than race it.
    timeoutMs: APPROVAL_TIMEOUT_MS + 15 * 60 * 1000,
    // The id to resume next time. Persisted as it arrives rather than after the
    // turn resolves, so a crash between the two does not lose the session.
    onSession: (sessionId) => {
      sessions[roomId] = { ...entry, sessionId, model }
      saveSessions()
    },
  })
}

// Creates a fresh agent room bound to `cwd` and invites the owner.
// Avatar for spawned rooms, one per provider so a Codex room is not mistaken
// for a Claude one in the room list. Uploaded once and the resulting mxc://
// cached, so every later spawn is just a state event. Absent icon or a failed
// upload is not fatal — rooms simply get the default letter tile.
const AVATAR_FILES = {
  claude: path.join(import.meta.dirname, 'agent-avatar.png'),
  codex: path.join(import.meta.dirname, 'agent-avatar-codex.png'),
}
const AVATAR_CACHE = path.join(STORE_DIR, 'avatar.json')
// provider -> mxc:// of its uploaded icon.
let avatarMxc = {}

// Every avatar this bot has ever uploaded. Used to tell "the icon we set last
// time" from "an avatar the user chose", so a new icon replaces the former
// without ever overwriting the latter.
let knownAvatars = []

async function ensureAvatars() {
  let cached = {}
  try {
    if (fs.existsSync(AVATAR_CACHE)) cached = JSON.parse(fs.readFileSync(AVATAR_CACHE, 'utf8'))
  } catch {}
  // The cache predating per-provider icons held a single {mxc, size}; that one
  // was the Claude icon, and its mxc still has to stay in `known` or the
  // backfill would treat every existing room's tile as user-chosen.
  const byProvider = cached.byProvider ?? (cached.mxc ? { claude: { mxc: cached.mxc, size: cached.size } } : {})
  knownAvatars = cached.known ?? (cached.mxc ? [cached.mxc] : [])

  for (const [provider, file] of Object.entries(AVATAR_FILES)) {
    try {
      if (!fs.existsSync(file)) continue
      const size = fs.statSync(file).size
      // Re-upload only if the icon changed since it was cached.
      if (byProvider[provider]?.mxc && byProvider[provider].size === size) {
        avatarMxc[provider] = byProvider[provider].mxc
        continue
      }
      const data = fs.readFileSync(file)
      const res = await client.uploadContent(data, {
        name: path.basename(file),
        type: 'image/png',
        rawResponse: false,
      })
      avatarMxc[provider] = res.content_uri
      byProvider[provider] = { mxc: res.content_uri, size: data.length }
      if (!knownAvatars.includes(res.content_uri)) knownAvatars.push(res.content_uri)
      log(`Uploaded ${provider} room avatar: ${res.content_uri}`)
    } catch (e) {
      log(`Avatar for ${provider} unavailable (${e.message}) — those rooms use the default tile.`)
    }
  }
  try {
    fs.writeFileSync(AVATAR_CACHE, JSON.stringify({ byProvider, known: knownAvatars }))
  } catch (e) {
    log(`Could not write the avatar cache (${e.message}); icons re-upload next start.`)
  }
}

// Short alias for a resolved model id, for display. Asks whichever provider
// owns the model, so an id from any backend renders as its own short name.
function modelLabel(model) {
  const owner = resolveModel(model)
  return owner ? PROVIDERS[owner.provider].label(model) : model
}

// Agent rooms are numbered rather than named after their directory: the avatar
// marks them, the header chip shows the model, and the topic carries where the
// room works, so the name only has to be short and unambiguous in a narrow tile.
const ROOM_PREFIX = 'BenderDev'
const ROOM_NAME_RE = /^BenderDev-(\d+)$/
// Names this bot generated before the current scheme. Only these get rewritten
// on startup; a name a human picked is never touched.
const LEGACY_NAME_RE = /^(agent: |⌁ )/

// The counter is persisted rather than derived from the rooms in flight. Room
// names looked like the obvious source, but a room renames itself to describe
// its work within its first turns, so a derived max regresses as soon as the
// numbered names are gone — and the reused number collides with the still-live
// `agent/<name>` branch and worktree directory of the earlier room, which makes
// `git worktree add` refuse and drops the new room into a shared tree.
const ROOM_COUNTER_FILE = path.join(STORE_DIR, 'room-counter.json')

// Seeded once from whatever numbers are already in use — names still following
// the scheme, plus the branches of live worktree rooms, which outlive the name.
function seedRoomCounter() {
  let max = 0
  for (const room of client.getRooms()) {
    const m = ROOM_NAME_RE.exec(room.name ?? '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  for (const entry of Object.values(sessions)) {
    const m = new RegExp(`^agent/${ROOM_PREFIX.toLowerCase()}-(\\d+)$`)
      .exec(entry.branch ?? '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

// Counts up rather than filling gaps, so a number is never reused by a
// different room. Written before it is handed out: a crash mid-spawn costs one
// number, while handing the same one out twice costs a room its worktree.
function nextRoomName() {
  let last = null
  if (fs.existsSync(ROOM_COUNTER_FILE)) {
    try { last = JSON.parse(fs.readFileSync(ROOM_COUNTER_FILE, 'utf8')).last } catch {}
  }
  if (typeof last !== 'number') last = seedRoomCounter()
  const next = last + 1
  fs.writeFileSync(ROOM_COUNTER_FILE, JSON.stringify({ last: next }))
  return `${ROOM_PREFIX}-${next}`
}

// Rooms sharing one working tree overwrite each other's edits mid-turn. When a
// spawn targets a repo another room already holds, the new room gets its own
// git worktree instead: same history and remotes, separate checkout, so
// concurrent turns are safe. Deliberately outside STORE_DIR, which lives in the
// repo: a worktree nested under its own origin is a second full checkout inside
// the tree agents search, so greps and file walks would see every file twice.
const WORKTREE_DIR = path.join(os.homedir(), '.claude-bot-worktrees')

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: (stdout ?? '').trim(),
        err: (stderr ?? '').trim() || err?.message || '',
      }))
  })
}

// Root of the working tree `dir` sits in, or null when it is not a checkout.
// A worktree reports its own root, not the main one — which is exactly the
// distinction that makes two rooms in two worktrees count as unshared.
async function worktreeRoot(dir) {
  const r = await git(['rev-parse', '--show-toplevel'], dir)
  return r.ok && r.out ? r.out : null
}

// Cuts a worktree for `roomName` off the tree at `root`, on a fresh branch from
// the current HEAD. Returns the new checkout path, or null if git refused —
// callers fall back to the shared tree rather than failing the spawn.
async function addWorktree(root, roomName) {
  fs.mkdirSync(WORKTREE_DIR, { recursive: true })
  const dest = path.join(WORKTREE_DIR, `${path.basename(root)}-${roomName}`)
  const branch = `agent/${roomName.toLowerCase()}`
  const r = await git(['worktree', 'add', '-b', branch, dest], root)
  if (!r.ok) {
    log(`Worktree for ${roomName} failed: ${r.err}`)
    return null
  }
  log(`Worktree ${dest} on ${branch} (from ${root})`)
  return { dest, branch }
}

// Called when a room ends. Refuses on a dirty tree — uncommitted work is the
// one thing here that cannot be recovered — and says so instead of forcing.
async function removeWorktree(dir, branch) {
  const status = await git(['status', '--porcelain'], dir)
  if (status.ok && status.out) return { removed: false, reason: 'uncommitted changes' }
  // Where to run git once this checkout no longer exists. The main worktree is
  // the first record `worktree list` prints.
  const list = await git(['worktree', 'list', '--porcelain'], dir)
  const main = list.ok ? list.out.split('\n')[0].replace(/^worktree /, '') : null
  const r = await git(['worktree', 'remove', dir], dir)
  if (!r.ok) return { removed: false, reason: r.err }
  // A branch holding commits no other ref can reach is the only record of what
  // the room did, so it stays. One that adds nothing is noise — every ended
  // room would leave one. Reachability, not a comparison against main: work
  // merged or pushed elsewhere is already safe, unmerged work never is.
  let branchDeleted = false
  if (branch && main) {
    // --exclude's pattern is matched relative to refs/heads/ for --branches, so
    // it is the bare name here. Spelling it refs/heads/… silently excludes
    // nothing, which makes every branch look empty and deletes real work.
    const unique = await git(
      ['rev-list', '--count', `refs/heads/${branch}`,
        '--not', '--exclude', branch, '--branches', '--remotes'], main)
    if (unique.ok && unique.out === '0') {
      branchDeleted = (await git(['branch', '-D', branch], main)).ok
    }
  }
  return { removed: true, branchDeleted }
}

async function spawnRoom(cwd, model, provider, worktreeFrom = null) {
  // The name is needed before the room exists: it names the worktree and its
  // branch, and the room's topic has to carry the path we actually bind to.
  const name = nextRoomName()
  let branch = null
  if (worktreeFrom) {
    const wt = await addWorktree(worktreeFrom, name)
    if (wt) {
      // Preserve where in the repo the spawn pointed, so `!spawn repo/api`
      // lands in the worktree's api/ rather than at its root.
      cwd = path.join(wt.dest, path.relative(worktreeFrom, cwd))
      fs.mkdirSync(cwd, { recursive: true })
      branch = wt.branch
    }
  }
  const { room_id } = await client.createRoom({
    name,
    // The header renders this. A worktree's path is a store-internal location
    // nobody navigates to, so name it by its branch instead — that is the
    // handle you actually use once the work leaves the room.
    topic: `${branch ?? cwd} · ${model}`,
    // Marks this as an agent room so Construct can seed the standard action
    // pills on accept. The bot cannot write them itself — pills live in the
    // user's account data, which only the user's own token may write.
    creation_content: { type: AGENT_ROOM_TYPE },
    // The creator is admin by default and everyone else PL0, which left the
    // owner unable to rename their own room (rename needs PL50). It is their
    // room; give them the same level as the bot.
    power_level_content_override: {
      users: { [USER_ID]: 100, ...(OWNER_ID ? { [OWNER_ID]: 100 } : {}) },
    },
    invite: OWNER_ID ? [OWNER_ID] : [],
    // Deliberately NOT encrypted. With megolm the homeserver has no plaintext,
    // so the push it hands the gateway carries no content.body and
    // api/matrix-push.js drops it as a badge-only update — agent rooms never
    // pushed. These are bot rooms on a homeserver we control, so plaintext is
    // the right trade for working notifications.
    initial_state: [
      ...(avatarMxc[provider] ? [{
        type: 'm.room.avatar',
        state_key: '',
        content: { url: avatarMxc[provider] },
      }] : []),
    ],
  })
  // `worktree` marks the cwd as ours to clean up on !end. A room bound to a
  // directory the user chose must never have it removed.
  sessions[room_id] = { sessionId: null, cwd, model, provider, ...(branch ? { worktree: true, branch } : {}) }
  saveSessions()
  log(`Spawned ${room_id} → ${cwd} [${model}]${branch ? ` on ${branch}` : ''}`)
  return { room_id, cwd, branch }
}

const startTs = Date.now()
// Rooms with a turn in flight — Claude Code turns are not concurrency-safe per session.
const busy = new Set()

// `roomId:cwd` pairs that have been warned about sharing a working tree. A
// second !spawn for the same pair is the confirmation and goes through.
const pendingSpawns = new Set()

// Attachments are handed to the agent as files on disk, because the CLI takes a
// text prompt only — a path it can Read is the sole way an image reaches it.
const MEDIA_DIR = path.join(STORE_DIR, 'media')
fs.mkdirSync(MEDIA_DIR, { recursive: true })

// Extension matters: the Read tool decides whether to load a file as an image
// from it, so a mis-named download silently degrades to "unreadable binary".
const MEDIA_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'application/pdf': '.pdf',
}

// Downloads an m.image/m.file attachment and returns its local path.
async function downloadAttachment(event) {
  const content = event.getContent()
  // Encrypted attachments arrive as content.file with the AES keys inline and
  // need a separate decrypt step; the Construct client uploads in the clear, so
  // this is a diagnostic rather than a path we support.
  if (content.file && !content.url) throw new Error('encrypted attachment (unsupported)')
  if (!content.url) throw new Error('no media url')

  // Media is authenticated on modern homeservers (MSC3916): the legacy
  // unauthenticated /_matrix/media/ route 404s, so the token must be sent.
  const url = client.mxcUrlToHttp(content.url, null, null, null, false, true, true)
  if (!url) throw new Error(`unusable media url: ${content.url}`)
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${client.getAccessToken()}` },
  })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  const mime = content.info?.mimetype ?? res.headers.get('content-type') ?? ''
  // Trust the sender's filename for its extension only, never for the path —
  // a body of "../../x" would otherwise escape MEDIA_DIR.
  const ext = MEDIA_EXT[mime.split(';')[0].trim()] ?? path.extname(content.body ?? '') ?? ''
  const file = path.join(MEDIA_DIR, `${event.getId().replace(/[^\w-]/g, '_')}${ext}`)
  fs.writeFileSync(file, buf)
  log(`Saved attachment ${file} (${buf.length} bytes, ${mime || 'unknown type'})`)
  return file
}

client.on(sdk.RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
  if (toStartOfTimeline) return                          // skip history
  if (event.getTs() < startTs) return                   // skip messages before bot started
  if (event.getSender() === USER_ID) return             // ignore own messages

  // Wait for decryption if needed
  if (event.getType() === 'm.room.encrypted' || event.isBeingDecrypted?.()) {
    await new Promise((resolve) => {
      const onDec = (e) => {
        if (e.getId() === event.getId()) {
          client.off(sdk.MatrixEventEvent.Decrypted, onDec)
          resolve()
        }
      }
      client.on(sdk.MatrixEventEvent.Decrypted, onDec)
      if (event.getType() !== 'm.room.encrypted') { client.off(sdk.MatrixEventEvent.Decrypted, onDec); resolve() }
    })
  }

  if (event.isDecryptionFailure()) {
    log(`Decrypt failure in ${room?.roomId}: ${event.decryptionFailureReason}`)
    return
  }
  if (event.getType() !== 'm.room.message') return

  const body = event.getContent()?.body?.trim()
  if (!body) return

  const roomId = room.roomId
  log(`[${room?.name ?? roomId}] ${event.getSender()}: ${body}`)

  // An attachment's body is just the filename, so forwarding it as a prompt
  // sends the agent a bare name and no picture — the reason images "didn't
  // arrive". Download it and point the agent at the file instead.
  const msgtype = event.getContent()?.msgtype
  if (msgtype === 'm.image' || msgtype === 'm.file') {
    if (busy.has(roomId)) {
      await sendRoomText(roomId, 'Still working on the previous message — hold on.')
      return
    }
    busy.add(roomId)
    await client.sendTyping(roomId, true, 30000)
    const keepAlive = setInterval(() => {
      client.sendTyping(roomId, true, 30000).catch(() => {})
    }, 25000)
    try {
      const file = await downloadAttachment(event)
      // The caption, when the client sends one, is the actual instruction; the
      // filename alone is not, so it is not repeated as the ask.
      const caption = event.getContent()?.filename && body !== event.getContent().filename ? body : ''
      const prompt = caption
        ? `${caption}\n\n(The attachment for this message is at ${file} — read it first.)`
        : `I sent you a file at ${file}. Read it and tell me what you see.`
      const res = await runTurn(roomId, prompt)
      await sendRoomText(roomId, res.error ? `⚠️ ${res.error}` : res.text)
    } catch (e) {
      await sendRoomText(roomId, `⚠️ Could not read that attachment: ${e.message}`).catch(() => {})
    } finally {
      clearInterval(keepAlive)
      await client.sendTyping(roomId, false).catch(() => {})
      busy.delete(roomId)
    }
    return
  }

  // !spawn [path] [model] — both optional, model recognised by being a known name.
  if (body.startsWith('!spawn')) {
    const parts = body.slice('!spawn'.length).trim().split(/\s+/).filter(Boolean)
    // The model name identifies its backend, so naming one is also how a room
    // picks a provider — no extra argument needed.
    let { provider, model } = DEFAULT
    if (parts.length) {
      const named = resolveModel(parts[parts.length - 1])
      if (named) {
        ;({ provider, model } = named)
        parts.pop()
      }
    }
    const arg = parts.join(' ')
    const cwd = arg ? path.resolve(arg.replace(/^~/, os.homedir())) : DEFAULT_CWD
    if (!fs.existsSync(cwd)) {
      await sendRoomText(roomId,`No such directory: ${cwd}`)
      return
    }
    // Rooms sharing a directory share one working tree, so concurrent turns
    // silently overwrite each other's edits. Compare by working-tree root, not
    // by cwd: two rooms in different subdirectories of one repo still collide.
    const root = await worktreeRoot(cwd)
    const sharing = []
    for (const id of Object.keys(sessions)) {
      const other = sessions[id].cwd
      const same = other === cwd || (root && await worktreeRoot(other) === root)
      if (same) sharing.push(client.getRoom(id)?.name ?? id)
    }
    // Inside a repo the collision is fixable, so fix it rather than asking: the
    // new room gets its own worktree. Outside one there is nothing to cut, so
    // fall back to warning once and letting a repeat through — sequential use
    // of the same directory is legitimate.
    if (sharing.length > 0 && !root && !pendingSpawns.has(`${roomId}:${cwd}`)) {
      pendingSpawns.add(`${roomId}:${cwd}`)
      await sendRoomText(roomId,
        `⚠️ ${sharing.join(', ')} ${sharing.length === 1 ? 'is' : 'are'} already working in ${path.basename(cwd)}. ` +
        'Running turns at the same time means both edit the same files.\n\nSend !spawn again to do it anyway.')
      return
    }
    pendingSpawns.delete(`${roomId}:${cwd}`)
    try {
      const spawned = await spawnRoom(cwd, model, provider, sharing.length > 0 ? root : null)
      const where = spawned.branch
        ? `a worktree of ${path.basename(cwd)} on \`${spawned.branch}\``
        : path.basename(cwd)
      await sendRoomText(roomId, `Spawned ${where} on ${modelLabel(model)} — check your invites.`)
      // A requested worktree that git refused still spawns, in the shared tree.
      if (sharing.length > 0 && root && !spawned.branch) {
        await sendRoomText(roomId,
          `⚠️ Couldn't cut a worktree, so it shares the tree with ${sharing.join(', ')} — don't run turns at the same time.`)
      }
    } catch (e) {
      await sendRoomText(roomId,`Spawn failed: ${e.message}`)
    }
    return
  }

  // !model [name] — report or change the model for this agent room.
  if (body.startsWith('!model')) {
    const entry = sessions[roomId]
    if (!entry) {
      await sendRoomText(roomId,'Not an agent room.')
      return
    }
    const provider = providerFor(entry)
    const arg = body.slice('!model'.length).trim()
    if (!arg) {
      // The seeded pill sends a bare !model, so reporting alone left no way to
      // switch without typing. Offer the alternatives as tappable options —
      // only this room's provider's, since switching backend is not a model
      // change and would strand the session.
      const current = entry.model ?? DEFAULT_MODEL
      const options = Object.keys(provider.models)
        .filter((alias) => provider.models[alias] !== current)
        .map((alias) => `[[!model ${alias}]]`)
        .join(' ')
      await sendRoomText(roomId, `Model: ${modelLabel(current)}\n\n${options}`)
      return
    }
    const resolved = resolveModel(arg)
    if (!resolved) {
      await sendRoomText(roomId, `Unknown model "${arg}". Try: ${allModelAliases().join(', ')}`)
      return
    }
    // A session belongs to the backend that created it, so a model from another
    // provider cannot be adopted mid-room. Say so rather than silently
    // continuing on the old one.
    if (resolved.provider !== provider.name) {
      await sendRoomText(roomId,
        `${modelLabel(resolved.model)} runs on ${resolved.provider}, but this room is a ${provider.name} room — ` +
        'the session cannot move. Spawn a new room with that model instead.')
      return
    }
    entry.model = resolved.model
    saveSessions()
    await sendRoomText(roomId, `Model: ${modelLabel(resolved.model)} — from your next message.`)
    return
  }

  // Only act as an agent in rooms that were spawned as agent rooms. The session
  // map is the usual answer, but it does not survive a lost sessions.json —
  // and a room whose entry is gone is precisely the one you want to end, so
  // fall back to the marker baked into m.room.create.
  if (!sessions[roomId] && !isAgentRoom(roomId)) return

  // !reset — keep the room, its directory and model; drop the session so the
  // next message starts fresh. For when the context is poisoned rather than the
  // room being unwanted. The old transcript stays on disk.
  if (body === '!reset') {
    if (!sessions[roomId]) {
      await sendRoomText(roomId, 'No session to reset — this room is already unbound. Use !end to close it.')
      return
    }
    if (settleApproval(roomId, 'deny', 'Session reset.')) {
      await sendRoomText(roomId, '🚫 Denied the pending approval as part of the reset.')
    }
    if (busy.has(roomId)) {
      await sendRoomText(roomId, 'A turn is still running — try again once it finishes.')
      return
    }
    sessions[roomId] = { ...sessions[roomId], sessionId: null }
    saveSessions()
    await sendRoomText(roomId, '↺ Fresh session. Directory and model are unchanged; I have no memory of this conversation now.')
    return
  }

  // !end — unbind the room and leave it. Confirmed because it cannot be undone
  // from chat and the button sits next to the others.
  if (body === '!end') {
    if (settleApproval(roomId, 'deny', 'Room is being ended.')) {
      await sendRoomText(roomId, '🚫 Denied the pending approval. Send !end again once the turn stops.')
      return
    }
    if (busy.has(roomId)) {
      await sendRoomText(roomId, 'A turn is still running — try again once it finishes.')
      return
    }
    pendingEnds.add(roomId)
    await sendRoomText(roomId, 'End this room? I will leave and forget the session. The transcript stays on disk.\n\n[[Confirm end]] [[Cancel]]')
    return
  }

  if (pendingEnds.has(roomId)) {
    const reply = body.toLowerCase()
    if (reply === 'confirm end') {
      pendingEnds.delete(roomId)
      const ended = sessions[roomId]
      delete sessions[roomId]
      saveSessions()
      log(`Ended ${roomId}`)
      // Only a worktree this bot cut is removable, and only when clean. Dirty
      // ones are left on disk with their path named — the room is going away,
      // so this message is the last chance to say where the work went.
      let leftover = ''
      if (ended?.worktree) {
        const { removed, reason, branchDeleted } = await removeWorktree(ended.cwd, ended.branch)
        if (!removed) {
          leftover = `\n\nKept the worktree — ${reason}: \`${ended.cwd}\` on \`${ended.branch}\`.`
        } else {
          leftover = branchDeleted
            ? '\n\nRemoved the worktree; nothing was committed, so the branch went too.'
            : `\n\nRemoved the worktree; branch \`${ended.branch}\` kept — it has commits.`
        }
      }
      // Say goodbye before leaving, or the message lands in a room we have left.
      await sendRoomText(roomId, `👋 Ended. Spawn a new room when you need me again.${leftover}`).catch(() => {})
      await client.leave(roomId).catch((e) => log(`Leave failed for ${roomId}: ${e.message}`))
      return
    }
    if (reply === 'cancel') {
      pendingEnds.delete(roomId)
      await sendRoomText(roomId, 'Cancelled — room is still active.')
      return
    }
  }

  // Approval answers must be handled before the busy check — the room is always
  // busy when one is outstanding, since the turn is blocked inside the hook.
  const answer = body.toLowerCase()
  if (answer === 'approve' || answer === 'yes' || answer === 'y') {
    if (settleApproval(roomId, 'allow', 'Approved in chat.')) {
      await sendRoomText(roomId,'✅ Approved — continuing.')
      return
    }
  }
  // Only offered when the provider can honour it; a backend that cannot will
  // never have posted the button, so this can only match a prompt that did.
  if (answer === 'always allow' || answer === 'always') {
    if (settleApproval(roomId, 'allow_session', 'Approved for the session in chat.')) {
      await sendRoomText(roomId, '✅ Approved — and I won\'t ask again this session.')
      return
    }
  }
  if (answer === 'deny' || answer === 'no' || answer === 'n') {
    if (settleApproval(roomId, 'deny', 'Denied in chat.')) {
      await sendRoomText(roomId,'🚫 Denied.')
      return
    }
  }

  if (busy.has(roomId)) {
    await sendRoomText(roomId,'Still working on the previous message — hold on.')
    return
  }
  busy.add(roomId)

  // Turns can run for minutes; keep the typing indicator alive so the room doesn't look dead.
  await client.sendTyping(roomId, true, 30000)
  const keepAlive = setInterval(() => {
    client.sendTyping(roomId, true, 30000).catch(() => {})
  }, 25000)

  try {
    const res = await runTurn(roomId, body)
    await sendRoomText(roomId,res.error ? `⚠️ ${res.error}` : res.text)
  } catch (e) {
    await sendRoomText(roomId,`⚠️ ${e.message}`).catch(() => {})
  } finally {
    clearInterval(keepAlive)
    await client.sendTyping(roomId, false).catch(() => {})
    busy.delete(roomId)
  }
})

await ensureAvatars()

// Rooms spawned before the avatar existed keep the default letter tile, and
// room state is server-side — so unlike a client change, this reaches every
// device immediately. Never overwrites an avatar that is already set.
//
// Also corrects a room whose icon belongs to the other provider: the icon it is
// wearing is one of ours, so replacing it is allowed by the same rule.
async function backfillAvatars() {
  for (const [roomId, entry] of Object.entries(sessions)) {
    try {
      const wanted = avatarMxc[entry.provider ?? DEFAULT_PROVIDER]
      if (!wanted) continue
      const room = client.getRoom(roomId)
      if (!room || room.getMyMembership() !== 'join') continue
      const current = room.currentState.getStateEvents('m.room.avatar', '')?.getContent()?.url
      if (current === wanted) continue
      // Replace an icon we set previously, but never one the user chose.
      if (current && !knownAvatars.includes(current)) continue
      await client.sendStateEvent(roomId, 'm.room.avatar', { url: wanted }, '')
      log(`Set ${entry.provider ?? DEFAULT_PROVIDER} avatar on ${roomId}`)
    } catch (e) {
      log(`Could not set avatar on ${roomId}: ${e.message}`)
    }
  }
}
await backfillAvatars()

// Rooms spawned under the old naming keep names like "agent: matrix-pwa".
// Renaming is server-side state, so it lands on every device without a client
// rebuild. Rooms already following the scheme are left alone.
async function backfillNames() {
  for (const roomId of Object.keys(sessions)) {
    try {
      const room = client.getRoom(roomId)
      if (!room || room.getMyMembership() !== 'join') continue
      // Only rewrite the old auto-generated names. Anything else is a name a
      // human chose — renaming a room to describe its purpose must survive a
      // bot restart.
      if (!LEGACY_NAME_RE.test(room.name ?? '')) continue
      const name = nextRoomName()
      await client.sendStateEvent(roomId, 'm.room.name', { name }, '')
      log(`Renamed ${roomId} → ${name}`)
    } catch (e) {
      log(`Could not rename ${roomId}: ${e.message}`)
    }
  }
}
await backfillNames()

// Rooms spawned before the override left the owner at PL0, so renaming them
// from Construct failed with user_level(0) < send_level(50). Server-side, so
// it applies to every device at once.
async function backfillPowerLevels() {
  if (!OWNER_ID) return
  for (const roomId of Object.keys(sessions)) {
    try {
      const room = client.getRoom(roomId)
      if (!room || room.getMyMembership() !== 'join') continue
      const evt = room.currentState.getStateEvents('m.room.power_levels', '')
      const content = evt?.getContent()
      if (!content || content.users?.[OWNER_ID] >= 100) continue
      await client.sendStateEvent(roomId, 'm.room.power_levels', {
        ...content,
        users: { ...content.users, [OWNER_ID]: 100 },
      }, '')
      log(`Granted ${OWNER_ID} admin in ${roomId}`)
    } catch (e) {
      log(`Could not set power levels in ${roomId}: ${e.message}`)
    }
  }
}
await backfillPowerLevels()

startApprovalBroker()

log(`Listening… default cwd: ${DEFAULT_CWD}, model: ${DEFAULT_MODEL}.`)
log('Send "!spawn [path] [model]" to create an agent room; "!model [name]" inside one to switch.')

process.on('SIGINT', async () => {
  log('Stopping…')
  await client.stopClient()
  process.exit(0)
})
