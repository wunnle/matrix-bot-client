// One side of a multi-message exchange test.
// A sends MSG_COUNT messages; B receives each one and ACKs with its index.
// Both sides verify every message decrypts correctly.
import * as fs from 'node:fs'

const STORE_DIR = process.env.STORE_DIR
if (!STORE_DIR) { console.error('STORE_DIR required'); process.exit(1) }
fs.mkdirSync(STORE_DIR, { recursive: true })
process.chdir(STORE_DIR)

const dbManagerMod = await import('node-indexeddb/dbManager')
await dbManagerMod.default.loadCache().catch((e) => console.error('loadCache:', e))
await import('node-indexeddb/auto')

const sdk = await import('matrix-js-sdk')
const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key.js')
const { calculateKeyCheck } = await import('matrix-js-sdk/lib/secret-storage.js')

const ROLE = process.env.ROLE // 'A' | 'B'
const isA = ROLE === 'A'
const tag = `[${ROLE}]`
const MSG_COUNT = Number(process.env.MSG_COUNT ?? 10)
const ROOM_ID = process.env.PING_ROOM_ID
const HOMESERVER = process.env.HOMESERVER
const USER_ID = isA ? process.env.USER_ID : process.env.USER_ID_B
const ACCESS_TOKEN = isA ? process.env.ACCESS_TOKEN : process.env.ACCESS_TOKEN_B
const DEVICE_ID = isA ? process.env.DEVICE_ID : process.env.DEVICE_ID_B
const RECOVERY_KEY = isA ? process.env.RECOVERY_KEY : process.env.RECOVERY_KEY_B

if (!USER_ID || !ACCESS_TOKEN || !DEVICE_ID || !ROOM_ID) {
  console.error(`${tag} missing env`); process.exit(1)
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]${tag}`, ...args)
}

function getCryptoStorageKey(userId, deviceId) {
  const input = `matrix-pwa:${userId}:${deviceId}`
  const key = new Uint8Array(32)
  for (let i = 0; i < input.length; i++) {
    key[i % 32] = (key[i % 32] * 31 + input.charCodeAt(i)) & 0xff
  }
  return key
}

const recoveryKeyBytes = RECOVERY_KEY
  ? (() => { try { return decodeRecoveryKey(RECOVERY_KEY) } catch { return null } })()
  : null

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

await client.initRustCrypto({ storageKey: getCryptoStorageKey(USER_ID, DEVICE_ID) })

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

const room = client.getRoom(ROOM_ID)
if (!room || room.getMyMembership() !== 'join') {
  await client.joinRoom(ROOM_ID)
}

log(`ready, MSG_COUNT=${MSG_COUNT}`)

// Resolve an event once fully decrypted (or immediately if already decrypted)
function waitDecrypted(event) {
  return new Promise((resolve) => {
    if (!event.isBeingDecrypted?.() && event.getType() !== 'm.room.encrypted') {
      resolve(event); return
    }
    const onDec = (e) => {
      if (e.getId() === event.getId()) {
        client.off(sdk.MatrixEventEvent.Decrypted, onDec)
        resolve(e)
      }
    }
    client.on(sdk.MatrixEventEvent.Decrypted, onDec)
    // If it was already decrypted before we attached the listener
    if (event.getType() !== 'm.room.encrypted') {
      client.off(sdk.MatrixEventEvent.Decrypted, onDec)
      resolve(event)
    }
  })
}

// Collect the next `count` messages from someone other than us, in order
function collectIncoming(count, prefix) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} messages`)), 120000)
    const received = []
    const seen = new Set()

    async function tryAdd(event) {
      if (event.getSender() === USER_ID) return
      const eid = event.getId()
      if (seen.has(eid)) return
      seen.add(eid)

      const resolved = await waitDecrypted(event)
      if (resolved.isDecryptionFailure()) {
        clearTimeout(timer)
        reject(new Error(`decrypt failed for ${eid}: ${resolved.decryptionFailureReason}`))
        return
      }
      const body = resolved.getContent()?.body ?? ''
      if (!body.startsWith(prefix)) return

      received.push(body)
      log(`received (${received.length}/${count}): ${body}`)

      if (received.length === count) {
        clearTimeout(timer)
        client.off(sdk.RoomEvent.Timeline, onTimeline)
        resolve(received)
      }
    }

    const onTimeline = (event, room_) => {
      if (room_?.roomId !== ROOM_ID) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return
      tryAdd(event)
    }

    client.on(sdk.RoomEvent.Timeline, onTimeline)
  })
}

async function send(text) {
  const r = await client.sendTextMessage(ROOM_ID, text)
  log(`sent: ${text} → ${r.event_id}`)
}

const errors = []

if (isA) {
  // A: give B time to listen, then send MSG_COUNT messages, then receive MSG_COUNT ACKs
  await new Promise((r) => setTimeout(r, 3000))
  for (let i = 1; i <= MSG_COUNT; i++) {
    await send(`MSG-A-${i}`)
  }
  log(`waiting for ${MSG_COUNT} ACKs from B…`)
  const acks = await collectIncoming(MSG_COUNT, 'ACK-B-')
  log(`got all ${acks.length} ACKs`)
} else {
  // B: receive MSG_COUNT messages from A, then ACK each one
  log(`waiting for ${MSG_COUNT} messages from A…`)
  const msgs = await collectIncoming(MSG_COUNT, 'MSG-A-')
  log(`got all ${msgs.length} messages, sending ACKs…`)
  for (let i = 1; i <= MSG_COUNT; i++) {
    await send(`ACK-B-${i}`)
  }
}

if (errors.length) {
  log('ERRORS:', errors)
  await client.stopClient()
  process.exit(1)
}

log(`PASS — ${MSG_COUNT} messages exchanged successfully`)
await new Promise((r) => setTimeout(r, 500))
await client.stopClient()
process.exit(0)
