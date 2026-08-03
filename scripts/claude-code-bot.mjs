// Claude Code bot — each Matrix room is a persistent Claude Code session.
// Send `!spawn [path]` in any room it's in to create a fresh agent room.
// Run: node --env-file=scripts/.env scripts/claude-code-bot.mjs
// Stop with Ctrl+C.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import { execFile } from 'node:child_process'

const STORE_DIR = path.resolve(import.meta.dirname, '.claude-bot-store')
fs.mkdirSync(STORE_DIR, { recursive: true })

const sdk = await import('matrix-js-sdk')
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

// Short names accepted in !spawn / !model, mapped to the exact CLI model ids.
const MODEL_ALIASES = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
}
const DEFAULT_MODEL = process.env.AGENT_MODEL ?? MODEL_ALIASES.opus

// Loopback only — the broker decides what the agent may do, so it must not be
// reachable from anywhere but the hook running on this host.
const APPROVAL_PORT = Number(process.env.AGENT_APPROVAL_PORT ?? 8787)
const APPROVAL_TIMEOUT_MS = Number(process.env.AGENT_APPROVAL_TIMEOUT_MS ?? 10 * 60 * 1000)
const HOOK_PATH = path.join(import.meta.dirname, 'claude-approval-hook.mjs')
const APPROVAL_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: `node ${HOOK_PATH}` }] },
    ],
  },
})

function resolveModel(name) {
  const key = name.toLowerCase()
  // Accept a bare alias or a full id; anything else is rejected by the caller.
  if (MODEL_ALIASES[key]) return MODEL_ALIASES[key]
  if (Object.values(MODEL_ALIASES).includes(key)) return key
  return null
}

if (!HOMESERVER || !USER_ID || !PASSWORD) {
  console.error('Missing HOMESERVER, USER_ID_C/USER_ID_B, or PASSWORD_C/PASSWORD_B in env')
  process.exit(1)
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}][claude-bot]`, ...args)
}

// roomId -> { sessionId, cwd }. One Claude Code session per room, forever.
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
    if (f !== '.session.json' && f !== 'sessions.json') {
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

// roomId -> { resolve, timer }. At most one outstanding approval per room:
// Claude is blocked inside the hook, so it cannot ask a second question.
const pendingApprovals = new Map()

function roomForSession(sessionId) {
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

// Blocks the hook's HTTP request until the human answers in the room.
function askForApproval(roomId, { toolName, summary }) {
  return new Promise((resolve) => {
    // A second request for a room that is already waiting would strand the
    // first; refuse rather than lose track of it.
    if (pendingApprovals.has(roomId)) {
      resolve({ decision: 'deny', reason: 'Another approval is already pending in this room.' })
      return
    }

    const timer = setTimeout(() => {
      pendingApprovals.delete(roomId)
      client.sendTextMessage(roomId, `⏱️ No answer — denied \`${toolName}\`.`).catch(() => {})
      resolve({ decision: 'deny', reason: 'Timed out waiting for approval.' })
    }, APPROVAL_TIMEOUT_MS)

    pendingApprovals.set(roomId, { resolve, timer })

    const body = `🔐 Approve \`${toolName}\`?\n\n${summary}\n\n[[Approve]] [[Deny]]`
    client.sendMessage(roomId, {
      msgtype: 'm.text',
      body,
      format: 'org.matrix.custom.html',
      formatted_body:
        `<p>🔐 Approve <code>${escapeHtml(toolName)}</code>?</p>` +
        `<pre><code>${escapeHtml(summary)}</code></pre>` +
        '<p>[[Approve]] [[Deny]]</p>',
    }).catch((e) => {
      // If we can't ask, we must not proceed as though we had.
      settleApproval(roomId, 'deny', `Could not post the approval request: ${e.message}`)
    })
  })
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
      const roomId = roomForSession(payload.sessionId)
      if (!roomId) {
        // No room means no one to ask — the safe answer is no.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny', reason: 'No Matrix room is bound to this session.' }))
        return
      }
      log(`[${roomId}] approval requested: ${payload.toolName} — ${payload.summary}`)
      const result = await askForApproval(roomId, payload)
      log(`[${roomId}] approval ${result.decision}: ${payload.toolName}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    })
  })
  server.listen(APPROVAL_PORT, '127.0.0.1', () => {
    log(`Approval broker on 127.0.0.1:${APPROVAL_PORT}`)
  })
  server.on('error', (e) => {
    log(`Approval broker failed: ${e.message} — tool calls needing approval will be denied.`)
  })
}

// Runs one Claude Code turn, resuming the room's session if it has one.
function runClaude(roomId, prompt) {
  const entry = sessions[roomId] ?? { sessionId: null, cwd: DEFAULT_CWD, model: DEFAULT_MODEL }
  const model = entry.model ?? DEFAULT_MODEL
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--model', model,
    // The PreToolUse hook is the real gate; see claude-approval-hook.mjs.
    '--settings', APPROVAL_SETTINGS,
  ]
  if (entry.sessionId) args.push('--resume', entry.sessionId)

  return new Promise((resolve) => {
    execFile('claude', args, {
      cwd: entry.cwd,
      // A turn can now block on a human answering an approval, so this must
      // exceed the approval timeout rather than race it.
      timeout: APPROVAL_TIMEOUT_MS + 15 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      // The hook runs as a grandchild of this process; hand it the broker
      // address so an overridden port stays consistent.
      env: {
        ...process.env,
        AGENT_APPROVAL_URL: `http://127.0.0.1:${APPROVAL_PORT}/approve`,
        AGENT_APPROVAL_TIMEOUT_MS: String(APPROVAL_TIMEOUT_MS),
      },
    }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ error: stderr?.trim() || err.message })
      try {
        const out = JSON.parse(stdout)
        if (out.session_id) {
          sessions[roomId] = { sessionId: out.session_id, cwd: entry.cwd, model }
          saveSessions()
        }
        resolve({ text: out.result ?? '(no output)', isError: out.is_error })
      } catch {
        resolve({ error: `Could not parse output:\n${stdout.slice(0, 500)}` })
      }
    })
  })
}

// Creates a fresh agent room bound to `cwd` and invites the owner.
// Short alias for a resolved model id, for display.
function modelLabel(model) {
  return Object.keys(MODEL_ALIASES).find((k) => MODEL_ALIASES[k] === model) ?? model
}

async function spawnRoom(cwd, model) {
  const label = path.basename(cwd)
  // Several agent rooms can share a repo and model, so the time disambiguates
  // them in the room list.
  const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const { room_id } = await client.createRoom({
    name: `⌁ ${label} · ${modelLabel(model)} · ${stamp}`,
    topic: `${cwd} · ${model}`,
    invite: OWNER_ID ? [OWNER_ID] : [],
    initial_state: [{
      type: 'm.room.encryption',
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    }],
  })
  sessions[room_id] = { sessionId: null, cwd, model }
  saveSessions()
  log(`Spawned ${room_id} → ${cwd} [${model}]`)
  return room_id
}

const startTs = Date.now()
// Rooms with a turn in flight — Claude Code turns are not concurrency-safe per session.
const busy = new Set()

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

  // !spawn [path] [model] — both optional, model recognised by being a known name.
  if (body.startsWith('!spawn')) {
    const parts = body.slice('!spawn'.length).trim().split(/\s+/).filter(Boolean)
    let model = DEFAULT_MODEL
    if (parts.length && resolveModel(parts[parts.length - 1])) {
      model = resolveModel(parts.pop())
    }
    const arg = parts.join(' ')
    const cwd = arg ? path.resolve(arg.replace(/^~/, os.homedir())) : DEFAULT_CWD
    if (!fs.existsSync(cwd)) {
      await client.sendTextMessage(roomId, `No such directory: ${cwd}`)
      return
    }
    try {
      await spawnRoom(cwd, model)
      await client.sendTextMessage(roomId, `Spawned agent room for ${cwd} on ${model} — check your invites.`)
    } catch (e) {
      await client.sendTextMessage(roomId, `Spawn failed: ${e.message}`)
    }
    return
  }

  // !model [name] — report or change the model for this agent room.
  if (body.startsWith('!model')) {
    const entry = sessions[roomId]
    if (!entry) {
      await client.sendTextMessage(roomId, 'Not an agent room.')
      return
    }
    const arg = body.slice('!model'.length).trim()
    if (!arg) {
      await client.sendTextMessage(roomId, `Model: ${entry.model ?? DEFAULT_MODEL}`)
      return
    }
    const resolved = resolveModel(arg)
    if (!resolved) {
      await client.sendTextMessage(roomId, `Unknown model "${arg}". Try: ${Object.keys(MODEL_ALIASES).join(', ')}`)
      return
    }
    entry.model = resolved
    saveSessions()
    await client.sendTextMessage(roomId, `Model set to ${resolved} — takes effect on your next message.`)
    return
  }

  // Only act as an agent in rooms that were spawned as agent rooms.
  if (!sessions[roomId]) return

  // Approval answers must be handled before the busy check — the room is always
  // busy when one is outstanding, since the turn is blocked inside the hook.
  const answer = body.toLowerCase()
  if (answer === 'approve' || answer === 'yes' || answer === 'y') {
    if (settleApproval(roomId, 'allow', 'Approved in chat.')) {
      await client.sendTextMessage(roomId, '✅ Approved — continuing.')
      return
    }
  }
  if (answer === 'deny' || answer === 'no' || answer === 'n') {
    if (settleApproval(roomId, 'deny', 'Denied in chat.')) {
      await client.sendTextMessage(roomId, '🚫 Denied.')
      return
    }
  }

  if (busy.has(roomId)) {
    await client.sendTextMessage(roomId, 'Still working on the previous message — hold on.')
    return
  }
  busy.add(roomId)

  // Turns can run for minutes; keep the typing indicator alive so the room doesn't look dead.
  await client.sendTyping(roomId, true, 30000)
  const keepAlive = setInterval(() => {
    client.sendTyping(roomId, true, 30000).catch(() => {})
  }, 25000)

  try {
    const res = await runClaude(roomId, body)
    await client.sendTextMessage(roomId, res.error ? `⚠️ ${res.error}` : res.text)
  } catch (e) {
    await client.sendTextMessage(roomId, `⚠️ ${e.message}`).catch(() => {})
  } finally {
    clearInterval(keepAlive)
    await client.sendTyping(roomId, false).catch(() => {})
    busy.delete(roomId)
  }
})

startApprovalBroker()

log(`Listening… default cwd: ${DEFAULT_CWD}, model: ${DEFAULT_MODEL}.`)
log('Send "!spawn [path] [model]" to create an agent room; "!model [name]" inside one to switch.')

process.on('SIGINT', async () => {
  log('Stopping…')
  await client.stopClient()
  process.exit(0)
})
