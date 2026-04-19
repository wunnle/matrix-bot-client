// Echo bot — logs in as bender-2 and echoes every message it receives.
// Add @bender-2:matrix.org to any room and it will reply.
// Run: node --env-file=scripts/.env scripts/echo-bot.mjs
// Stop with Ctrl+C.
import * as fs from 'node:fs'
import * as path from 'node:path'

const STORE_DIR = path.resolve(import.meta.dirname, '.echo-bot-store')
fs.mkdirSync(STORE_DIR, { recursive: true })

const sdk = await import('matrix-js-sdk')
const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key.js')
const { calculateKeyCheck } = await import('matrix-js-sdk/lib/secret-storage.js')

const HOMESERVER = process.env.HOMESERVER
const USER_ID = process.env.USER_ID_B
const PASSWORD = process.env.PASSWORD_B

if (!HOMESERVER || !USER_ID || !PASSWORD) {
  console.error('Missing HOMESERVER, USER_ID_B, or PASSWORD_B in env')
  process.exit(1)
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}][echo-bot]`, ...args)
}

// Always do a fresh login so we get a valid token (stored tokens may be stale)
log(`Logging in as ${USER_ID}…`)
const loginRes = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: USER_ID },
    password: PASSWORD,
    initial_device_display_name: 'matrix-pwa echo-bot',
  }),
})
if (!loginRes.ok) {
  console.error('Login failed:', await loginRes.text())
  process.exit(1)
}
const { access_token, device_id } = await loginRes.json()
log(`device: ${device_id}`)

// Wipe store if it was created for a different device (do this BEFORE loadCache)
const DEVICE_TAG_FILE = path.join(STORE_DIR, '.device')
const storedDevice = fs.existsSync(DEVICE_TAG_FILE) ? fs.readFileSync(DEVICE_TAG_FILE, 'utf8').trim() : null
if (storedDevice && storedDevice !== device_id) {
  log(`Device changed (${storedDevice} → ${device_id}), wiping crypto store…`)
  for (const f of fs.readdirSync(STORE_DIR)) {
    if (f !== '.device') fs.rmSync(path.join(STORE_DIR, f), { recursive: true, force: true })
  }
}
fs.writeFileSync(DEVICE_TAG_FILE, device_id)

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

const RECOVERY_KEY_STR = process.env.RECOVERY_KEY_B ?? ''
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
  log(`  ${r.roomId}  ${r.name}`)
})
log('Invite @bender-2:matrix.org to any room to start echoing.')

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

// Echo messages
const startTs = Date.now()
client.on(sdk.RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
  if (toStartOfTimeline) return                          // skip history
  if (event.getTs() < startTs) return                   // skip messages before bot started
  if (event.getSender() === USER_ID) return             // don't echo own messages

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

  const body = event.getContent()?.body
  if (!body) return

  const sender = event.getSender()
  log(`[${room?.name ?? room?.roomId}] ${sender}: ${body}`)

  let reply
  if (body.trim() === '!actionable') {
    reply = 'Sure, what would you like to do? [Confirm] [Cancel] [Remind me later]'
  } else {
    reply = `echo: ${body}`
  }

  try {
    await client.sendTextMessage(room.roomId, reply)
  } catch (e) {
    log(`Send failed: ${e.message}`)
  }
})

log('Listening… (Ctrl+C to stop)')

process.on('SIGINT', async () => {
  log('Stopping…')
  await client.stopClient()
  process.exit(0)
})
