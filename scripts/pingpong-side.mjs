// One side of a two-account ping-pong E2EE test.
// Run via test-pingpong.mjs which spawns two instances with different ROLE.
// Uses node-indexeddb (Level-backed, persistent) so crypto state survives
// across runs — fake-indexeddb is in-memory only and caused OTK collisions
// because the server kept old OTKs at slots the rust crypto kept regenerating.
import * as fs from 'node:fs'

const STORE_DIR = process.env.STORE_DIR
if (!STORE_DIR) {
  console.error('STORE_DIR must be set (per-role persistent crypto dir)')
  process.exit(1)
}
fs.mkdirSync(STORE_DIR, { recursive: true })
process.chdir(STORE_DIR)

const dbManagerMod = await import('node-indexeddb/dbManager')
const dbManager = dbManagerMod.default
await dbManager.loadCache().catch((e) => console.error('loadCache:', e))
await import('node-indexeddb/auto')

const sdk = await import('matrix-js-sdk')
const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key.js')
const { calculateKeyCheck } = await import('matrix-js-sdk/lib/secret-storage.js')

const ROLE = process.env.ROLE // 'sender' | 'receiver'
const tag = ROLE === 'sender' ? 'A/sender' : 'B/receiver'

const isSender = ROLE === 'sender'
const HOMESERVER = process.env.HOMESERVER
const USER_ID = isSender ? process.env.USER_ID : process.env.USER_ID_B
const ACCESS_TOKEN = isSender ? process.env.ACCESS_TOKEN : process.env.ACCESS_TOKEN_B
const DEVICE_ID = isSender ? process.env.DEVICE_ID : process.env.DEVICE_ID_B
const RECOVERY_KEY = isSender ? process.env.RECOVERY_KEY : process.env.RECOVERY_KEY_B
const ROOM_ID = process.env.PING_ROOM_ID

if (!USER_ID || !ACCESS_TOKEN || !DEVICE_ID || !ROOM_ID) {
  console.error(`[${tag}] missing env`)
  process.exit(1)
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}][${tag}]`, ...args)
}

function getCryptoStorageKey(userId, deviceId) {
  const input = `matrix-pwa:${userId}:${deviceId}`
  const key = new Uint8Array(32)
  for (let i = 0; i < input.length; i++) {
    key[i % 32] = (key[i % 32] * 31 + input.charCodeAt(i)) & 0xff
  }
  return key
}

const recoveryKeyBytes = RECOVERY_KEY ? decodeRecoveryKey(RECOVERY_KEY) : null

const client = sdk.createClient({
  baseUrl: HOMESERVER,
  accessToken: ACCESS_TOKEN,
  userId: USER_ID,
  deviceId: DEVICE_ID,
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

log('init crypto…')
await client.initRustCrypto({ storageKey: getCryptoStorageKey(USER_ID, DEVICE_ID) })
const crypto = client.getCrypto()

log('start + sync…')
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('sync timeout')), 30000)
  const onSync = (state) => {
    if (state === 'PREPARED' || state === 'SYNCING') {
      clearTimeout(timeout)
      client.off(sdk.ClientEvent.Sync, onSync)
      resolve()
    } else if (state === 'ERROR') {
      clearTimeout(timeout)
      client.off(sdk.ClientEvent.Sync, onSync)
      reject(new Error('sync failed'))
    }
  }
  client.on(sdk.ClientEvent.Sync, onSync)
  client.startClient({ lazyLoadMembers: true })
})

if (recoveryKeyBytes) {
  log('bootstrap cross-signing…')
  try { await crypto.bootstrapCrossSigning({}) } catch (e) { log('bootstrap error:', e?.message) }
  try { await crypto.loadSessionBackupPrivateKeyFromSecretStorage() } catch {}
  try { await crypto.restoreKeyBackup() } catch {}
}

// Ensure joined
const room = client.getRoom(ROOM_ID)
if (!room || room.getMyMembership() !== 'join') {
  log('joining room…')
  await client.joinRoom(ROOM_ID)
}
log('in room:', client.getRoom(ROOM_ID)?.name)
log('room encrypted?', await crypto.isEncryptionEnabledInRoom(ROOM_ID))
log('isCrossSigningReady:', await crypto.isCrossSigningReady())

const SENT_PREFIX = isSender ? 'PING' : 'PONG'
const EXPECTED_PREFIX = isSender ? 'PONG' : 'PING'
const MATCH_TOKEN = process.env.MATCH_TOKEN ?? Date.now().toString()
const OUT_MSG = `${SENT_PREFIX} ${MATCH_TOKEN}`

async function waitForIncoming(expectedPrefix) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), 60000)
    const seen = new Set()

    function tryResolve(event) {
      if (event.isDecryptionFailure()) {
        log(`decrypt fail for ${event.getId()}: ${event.decryptionFailureReason}`)
        return false
      }
      if (event.getType() === 'm.room.encrypted') return false // still encrypted
      const body = event.getContent()?.body ?? ''
      log(`got from ${event.getSender()}: ${body}`)
      if (body !== `${expectedPrefix} ${MATCH_TOKEN}`) return false
      clearTimeout(timer)
      client.off(sdk.RoomEvent.Timeline, onTimeline)
      client.off(sdk.MatrixEventEvent.Decrypted, onDecrypted)
      resolve({ kind: 'ok', sender: event.getSender(), body, eventId: event.getId() })
      return true
    }

    const onTimeline = (event, room_) => {
      if (room_?.roomId !== ROOM_ID) return
      if (event.getSender() === USER_ID) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return
      const eid = event.getId()
      if (seen.has(eid)) return
      seen.add(eid)
      if (!tryResolve(event)) {
        log(`waiting on decrypt for ${eid}…`)
      }
    }

    const onDecrypted = (event) => {
      if (event.getRoomId() !== ROOM_ID) return
      if (event.getSender() === USER_ID) return
      if (!seen.has(event.getId())) return
      tryResolve(event)
    }

    client.on(sdk.RoomEvent.Timeline, onTimeline)
    client.on(sdk.MatrixEventEvent.Decrypted, onDecrypted)
  })
}

async function sendMsg(text) {
  log(`sending: ${text}`)
  const r = await client.sendTextMessage(ROOM_ID, text)
  log(`sent: ${r.event_id}`)
}

let result
if (isSender) {
  // Small delay to give receiver time to be listening
  await new Promise((r) => setTimeout(r, 3000))
  await sendMsg(OUT_MSG)
  log(`waiting for ${EXPECTED_PREFIX}…`)
  result = await waitForIncoming(EXPECTED_PREFIX)
} else {
  log(`waiting for ${EXPECTED_PREFIX}…`)
  result = await waitForIncoming(EXPECTED_PREFIX)
  if (result.kind === 'ok') {
    await sendMsg(OUT_MSG)
  }
}

log('RESULT:', JSON.stringify(result))

await new Promise((r) => setTimeout(r, 1000))
await client.stopClient()
process.exit(result.kind === 'ok' ? 0 : 2)
