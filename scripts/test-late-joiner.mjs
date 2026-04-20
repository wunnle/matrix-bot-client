// Tests whether a device that joins a room after messages were sent can decrypt history.
// Flow:
//   1. bender-1 (device A1) sends N messages to the room
//   2. bender-1 logs in again as a NEW device (A2) — simulates clearing the browser
//   3. A2 syncs and attempts to read the same messages
//   4. Expected: HISTORICAL_MESSAGE_NO_KEY_BACKUP (no backup configured) —
//      the messages are undecryptable without key backup/sharing, which is correct.
//      If a recovery key is set in .env, we also test that restoreKeyBackup works.
//
// This tells us exactly what a new device can and can't see, so we know what
// to show in the UI (and what to tell the user).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

const repoRoot = process.cwd()
const envFile = path.resolve(repoRoot, 'scripts/.env')
const freshLoginScript = path.resolve(repoRoot, 'scripts/fresh-login.mjs')

// Load env
const env = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').trim().split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=').map((p, i) => i === 0 ? p : l.slice(p.length + 1)))
    .map(([k, v]) => [k, v ?? ''])
)

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args)
}

// --- Step 1: fresh devices ---
log('Step 1: mint fresh devices…')
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [`--env-file=${envFile}`, freshLoginScript], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fresh-login exited ${code}`))))
})

// Re-read env after fresh-login wrote new tokens
const envUpdated = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').trim().split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => { const idx = l.indexOf('='); return [l.slice(0, idx), l.slice(idx + 1)] })
)

// --- Step 2: bender-1 device A1 sends messages ---
log('Step 2: A1 sends 5 messages…')

const storeA1 = path.resolve(repoRoot, 'scripts/.late-joiner-A1')
fs.rmSync(storeA1, { recursive: true, force: true })
fs.mkdirSync(storeA1)

const SENT_EVENT_IDS = []

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
import * as fs from 'node:fs'
process.chdir(${JSON.stringify(storeA1)})
const dbManagerMod = await import('node-indexeddb/dbManager')
await dbManagerMod.default.loadCache().catch(() => {})
await import('node-indexeddb/auto')
const sdk = await import('matrix-js-sdk')
const client = sdk.createClient({
  baseUrl: ${JSON.stringify(envUpdated.HOMESERVER)},
  accessToken: ${JSON.stringify(envUpdated.ACCESS_TOKEN)},
  userId: ${JSON.stringify(envUpdated.USER_ID)},
  deviceId: ${JSON.stringify(envUpdated.DEVICE_ID)},
})
function getCryptoStorageKey(userId, deviceId) {
  const input = 'matrix-pwa:' + userId + ':' + deviceId
  const key = new Uint8Array(32)
  for (let i = 0; i < input.length; i++) key[i % 32] = (key[i % 32] * 31 + input.charCodeAt(i)) & 0xff
  return key
}
await client.initRustCrypto({ storageKey: getCryptoStorageKey(${JSON.stringify(envUpdated.USER_ID)}, ${JSON.stringify(envUpdated.DEVICE_ID)}) })
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('sync timeout')), 30000)
  client.on('sync', (s) => { if (s === 'PREPARED' || s === 'SYNCING') { clearTimeout(t); res() } else if (s === 'ERROR') { clearTimeout(t); rej(new Error('sync failed')) } })
  client.startClient({ lazyLoadMembers: true })
})
const ROOM_ID = ${JSON.stringify(envUpdated.PING_ROOM_ID)}
const ids = []
for (let i = 1; i <= 5; i++) {
  const r = await client.sendTextMessage(ROOM_ID, 'HISTORY-MSG-' + i)
  ids.push(r.event_id)
  process.stdout.write('SENT:' + r.event_id + '\\n')
}
await client.stopClient()
      `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.on('data', (d) => {
    const lines = d.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('SENT:')) SENT_EVENT_IDS.push(line.slice(5))
      else process.stdout.write(line + '\n')
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(d))
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`A1 sender exited ${code}`))))
})

log('A1 sent event IDs:', SENT_EVENT_IDS)

// --- Step 3: bender-1 logs in as a NEW device A2 (clear browser simulation) ---
log('Step 3: bender-1 logs in as new device A2…')

const loginRes = await fetch(`${envUpdated.HOMESERVER}/_matrix/client/v3/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: envUpdated.USER_ID },
    password: envUpdated.PASSWORD,
    initial_device_display_name: 'matrix-pwa late-joiner-A2',
  }),
})
if (!loginRes.ok) throw new Error(`A2 login failed: ${loginRes.status}`)
const loginData = await loginRes.json()
const A2 = { userId: loginData.user_id, accessToken: loginData.access_token, deviceId: loginData.device_id }
log('A2 device:', A2.deviceId)

// --- Step 4: A2 syncs and tries to read history ---
log('Step 4: A2 syncs and attempts to read history…')

const storeA2 = path.resolve(repoRoot, 'scripts/.late-joiner-A2')
fs.rmSync(storeA2, { recursive: true, force: true })
fs.mkdirSync(storeA2)

const results = await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
import * as fs from 'node:fs'
process.chdir(${JSON.stringify(storeA2)})
const dbManagerMod = await import('node-indexeddb/dbManager')
await dbManagerMod.default.loadCache().catch(() => {})
await import('node-indexeddb/auto')
const sdk = await import('matrix-js-sdk')

const RECOVERY_KEY_STR = ${JSON.stringify(envUpdated.RECOVERY_KEY ?? '')}
let recoveryKeyBytes = null
if (RECOVERY_KEY_STR) {
  const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key.js')
  const { calculateKeyCheck } = await import('matrix-js-sdk/lib/secret-storage.js')
  try { recoveryKeyBytes = decodeRecoveryKey(RECOVERY_KEY_STR) } catch {}
}

const client = sdk.createClient({
  baseUrl: ${JSON.stringify(envUpdated.HOMESERVER)},
  accessToken: ${JSON.stringify(A2.accessToken)},
  userId: ${JSON.stringify(A2.userId)},
  deviceId: ${JSON.stringify(A2.deviceId)},
  cryptoCallbacks: {
    getSecretStorageKey: async ({ keys }) => {
      if (!recoveryKeyBytes) return null
      const { calculateKeyCheck } = await import('matrix-js-sdk/lib/secret-storage.js')
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

function getCryptoStorageKey(userId, deviceId) {
  const input = 'matrix-pwa:' + userId + ':' + deviceId
  const key = new Uint8Array(32)
  for (let i = 0; i < input.length; i++) key[i % 32] = (key[i % 32] * 31 + input.charCodeAt(i)) & 0xff
  return key
}

await client.initRustCrypto({ storageKey: getCryptoStorageKey(${JSON.stringify(A2.userId)}, ${JSON.stringify(A2.deviceId)}) })
const crypto = client.getCrypto()

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('sync timeout')), 30000)
  client.on('sync', (s) => { if (s === 'PREPARED' || s === 'SYNCING') { clearTimeout(t); res() } else if (s === 'ERROR') { clearTimeout(t); rej(new Error('sync failed')) } })
  client.startClient({ lazyLoadMembers: true })
})

if (recoveryKeyBytes) {
  try { await crypto.bootstrapCrossSigning({}) } catch {}
  try { await crypto.loadSessionBackupPrivateKeyFromSecretStorage() } catch {}
  try {
    const r = await crypto.restoreKeyBackup()
    process.stdout.write('BACKUP_RESTORE:' + JSON.stringify(r) + '\\n')
  } catch (e) { process.stdout.write('BACKUP_RESTORE_FAIL:' + e.message + '\\n') }
}

const ROOM_ID = ${JSON.stringify(envUpdated.PING_ROOM_ID)}
const TARGET_IDS = ${JSON.stringify(SENT_EVENT_IDS)}
const room = client.getRoom(ROOM_ID)
const events = room?.getLiveTimeline().getEvents() ?? []

// Wait a moment for pending decryptions
await new Promise((r) => setTimeout(r, 3000))

const out = []
for (const eid of TARGET_IDS) {
  const event = events.find((e) => e.getId() === eid)
  if (!event) { out.push({ eid, status: 'not_in_timeline' }); continue }
  const body = event.getContent()?.body
  const failed = event.isDecryptionFailure()
  const reason = failed ? String(event.decryptionFailureReason) : null
  out.push({ eid, status: failed ? 'decrypt_failed' : (body ? 'ok' : 'no_body'), body, reason })
}
process.stdout.write('RESULTS:' + JSON.stringify(out) + '\\n')

await client.stopClient()
      `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let resultsData = null
  child.stdout.on('data', (d) => {
    const lines = d.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('RESULTS:')) resultsData = JSON.parse(line.slice(8))
      else if (line.startsWith('BACKUP_RESTORE:')) log('backup restore:', line.slice(15))
      else if (line.startsWith('BACKUP_RESTORE_FAIL:')) log('backup restore failed:', line.slice(20))
      else process.stdout.write(line + '\n')
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(d))
  child.on('exit', (code) => {
    if (resultsData) resolve(resultsData)
    else reject(new Error(`A2 reader exited ${code} without results`))
  })
})

log('\n=== LATE JOINER RESULTS ===')
let allAccountedFor = true
for (const r of results) {
  log(r.eid, '→', r.status, r.body ?? r.reason ?? '')
  if (r.status === 'not_in_timeline') allAccountedFor = false
}

const okCount = results.filter((r) => r.status === 'ok').length
const failCount = results.filter((r) => r.status === 'decrypt_failed').length
const missingCount = results.filter((r) => r.status === 'not_in_timeline').length

log(`\nSummary: ${okCount} decrypted, ${failCount} decrypt_failed, ${missingCount} not_in_timeline`)

if (missingCount > 0) {
  log('WARN: some events never appeared in timeline — sync may be incomplete')
}

if (okCount === results.length) {
  log('PASS: all messages readable (key backup/sharing worked)')
} else if (failCount > 0 && okCount === 0) {
  log('EXPECTED: new device cannot read history without key backup — correct E2EE behavior')
  log('UI should show "🔒 Unable to decrypt" for these messages')
} else {
  log('PARTIAL: some messages readable, some not')
}

process.exit(missingCount > 0 ? 1 : 0)
