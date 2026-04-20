// Reproduces the app's E2EE init path in Node so we can iterate on the crypto
// setup without a browser. Uses fake-indexeddb to stand in for the browser's
// IndexedDB. Run with: node --env-file=scripts/.env scripts/test-e2ee.mjs
import 'fake-indexeddb/auto'
import * as sdk from 'matrix-js-sdk'
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key.js'
import { calculateKeyCheck } from 'matrix-js-sdk/lib/secret-storage.js'

const {
  HOMESERVER,
  USER_ID,
  ACCESS_TOKEN,
  DEVICE_ID,
  TEST_ROOM_ID,
  RECOVERY_KEY, // if set, bootstrap cross-signing + key backup so this device becomes verified
} = process.env

for (const [k, v] of Object.entries({ HOMESERVER, USER_ID, ACCESS_TOKEN, DEVICE_ID, TEST_ROOM_ID })) {
  if (!v) {
    console.error(`Missing env: ${k}`)
    process.exit(1)
  }
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args)
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
      // Account may have multiple secret storage keys — only one matches our
      // recovery key. Compare MACs to pick the right keyId.
      for (const [keyId, info] of Object.entries(keys)) {
        if (!info?.iv || !info?.mac) continue
        try {
          const { mac } = await calculateKeyCheck(recoveryKeyBytes, info.iv)
          // Server strips base64 padding on some entries; compare without it.
          const norm = (s) => s.replace(/=+$/, '')
          if (norm(mac) === norm(info.mac)) return [keyId, recoveryKeyBytes]
        } catch {}
      }
      return null
    },
  },
})

log('initRustCrypto…')
await client.initRustCrypto({ storageKey: getCryptoStorageKey(USER_ID, DEVICE_ID) })
log('crypto initialized')

const crypto = client.getCrypto()
log('crypto backend:', crypto?.constructor?.name ?? '(none)')

log('startClient + waiting for sync…')
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('sync timeout 30s')), 30000)
  const onSync = (state) => {
    log('sync state:', state)
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
log('sync done')

const room = client.getRoom(TEST_ROOM_ID)
if (!room) {
  console.error(`Room not found: ${TEST_ROOM_ID}`)
  console.error('Joined rooms:', client.getRooms().map((r) => ({ id: r.roomId, name: r.name })))
  process.exit(1)
}
log('room:', room.name)
log('encrypted?', await crypto.isEncryptionEnabledInRoom(TEST_ROOM_ID))

log('isCrossSigningReady (before):', await crypto.isCrossSigningReady())
log('device verification status (before):',
    await crypto.getDeviceVerificationStatus(USER_ID, DEVICE_ID))

if (RECOVERY_KEY) {
  log('bootstrapping cross-signing using recovery key…')
  try {
    await crypto.bootstrapCrossSigning({})
    log('cross-signing bootstrapped')
  } catch (e) {
    log('bootstrapCrossSigning failed:', e?.message ?? e)
  }

  log('loading session backup key from secret storage…')
  try {
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
    log('session backup key loaded')
  } catch (e) {
    log('load backup key failed:', e?.message ?? e)
  }

  log('restoring key backup (history)…')
  try {
    const res = await crypto.restoreKeyBackup()
    log('backup restored — imported', res.imported, 'of', res.total, 'keys')
  } catch (e) {
    log('restoreKeyBackup failed:', e?.message ?? e)
  }

  log('checkKeyBackupAndEnable…')
  try {
    const r = await crypto.checkKeyBackupAndEnable()
    log('backup check:', r ? { backupInfo: r.backupInfo?.version, trustInfo: r.trustInfo } : null)
  } catch (e) {
    log('checkKeyBackupAndEnable failed:', e?.message ?? e)
  }

  log('isCrossSigningReady (after):', await crypto.isCrossSigningReady())
  log('device verification status (after):',
      await crypto.getDeviceVerificationStatus(USER_ID, DEVICE_ID))
}

const prompt = process.env.PROMPT ?? `ping from test-e2ee.mjs @ ${new Date().toISOString().slice(11, 19)}`
log('sending prompt:', prompt)
let sentEventId
try {
  const result = await client.sendTextMessage(TEST_ROOM_ID, prompt)
  sentEventId = result.event_id
  log('SEND OK:', sentEventId)
} catch (e) {
  log('SEND FAILED:', e?.message)
  console.error(e)
  await client.stopClient()
  process.exit(2)
}

const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS ?? 45000)
log(`waiting up to ${REPLY_TIMEOUT_MS / 1000}s for a reply from someone other than us…`)

const replyResult = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ kind: 'timeout' }), REPLY_TIMEOUT_MS)

  const onTimeline = async (event, room_, toStartOfTimeline, removed, data) => {
    const rid = room_?.roomId
    if (rid !== TEST_ROOM_ID) return
    const sender = event.getSender()
    const type = event.getType()
    const eid = event.getId()
    const isLive = data?.liveEvent
    log(`[timeline] room=${rid} sender=${sender} type=${type} id=${eid} live=${isLive} back=${toStartOfTimeline}`)

    if (sender === USER_ID) return
    if (type !== 'm.room.message' && type !== 'm.room.encrypted') return
    if (eid === sentEventId) return

    if (event.isBeingDecrypted?.()) {
      log('  → decrypting, waiting…')
      await new Promise((r) => {
        const ondec = (e) => {
          if (e.getId() === eid) {
            client.off(sdk.MatrixEventEvent.Decrypted, ondec)
            r()
          }
        }
        client.on(sdk.MatrixEventEvent.Decrypted, ondec)
      })
    }

    const failed = event.isDecryptionFailure()
    const body = event.getContent()?.body

    clearTimeout(timer)
    client.off(sdk.RoomEvent.Timeline, onTimeline)
    resolve({
      kind: failed ? 'decrypt_failed' : 'ok',
      sender,
      eventId: eid,
      type: event.getType(),
      body,
      error: failed ? String(event.decryptionFailureReason) : undefined,
    })
  }

  client.on(sdk.RoomEvent.Timeline, onTimeline)

  // Also watch for decrypted events that may have slipped past Timeline
  client.on(sdk.MatrixEventEvent.Decrypted, (event) => {
    if (event.getRoomId() !== TEST_ROOM_ID) return
    if (event.getSender() === USER_ID) return
    log(`[decrypted] sender=${event.getSender()} id=${event.getId()} body=${JSON.stringify(event.getContent()?.body)?.slice(0, 80)}`)
  })
})

log('reply result:', JSON.stringify(replyResult, null, 2))

await client.stopClient()
log('done')
process.exit(replyResult.kind === 'ok' ? 0 : 3)
