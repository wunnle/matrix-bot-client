import * as sdk from 'matrix-js-sdk'
import type { AuthState } from '../types'

let client: sdk.MatrixClient | null = null

export function getClient(): sdk.MatrixClient {
  if (!client) throw new Error('Matrix client not initialized')
  return client
}

export function createClient(auth: AuthState): sdk.MatrixClient {
  client = sdk.createClient({
    baseUrl: auth.homeserver,
    accessToken: auth.accessToken,
    userId: auth.userId,
    deviceId: auth.deviceId,
  })
  return client
}

export function destroyClient() {
  if (client) {
    client.stopClient()
    client = null
  }
}

export interface RoomSummary {
  roomId: string
  name: string
  lastMessage?: string
  lastTs?: number
  unreadCount: number
}

function getRooms(c: sdk.MatrixClient): RoomSummary[] {
  return c.getRooms()
    .map((room) => {
      const timeline = room.getLiveTimeline().getEvents()
      const last = [...timeline].reverse().find((e) => e.getType() === 'm.room.message')
      return {
        roomId: room.roomId,
        name: room.name,
        lastMessage: last?.getContent()?.body,
        lastTs: last?.getTs(),
        unreadCount: room.getUnreadNotificationCount(),
      }
    })
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
}

// Derive a stable 32-byte key from userId+deviceId stored in localStorage
async function getCryptoStorageKey(userId: string, deviceId: string): Promise<Uint8Array> {
  const storageKey = `crypto_key_${userId}_${deviceId}`
  const existing = localStorage.getItem(storageKey)
  if (existing) {
    return new Uint8Array(JSON.parse(existing))
  }
  const key = crypto.getRandomValues(new Uint8Array(32))
  localStorage.setItem(storageKey, JSON.stringify(Array.from(key)))
  return key
}

export async function fetchJoinedRooms(auth: AuthState): Promise<RoomSummary[]> {
  const c = createClient(auth)

  // Initialize E2EE — storageKey ties crypto identity to this user/device
  await c.initRustCrypto({
    storageKey: await getCryptoStorageKey(auth.userId, auth.deviceId),
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync timed out')), 30000)

    const onSync = (state: string) => {
      if (state === 'PREPARED' || state === 'SYNCING') {
        clearTimeout(timeout)
        c.off(sdk.ClientEvent.Sync, onSync)
        // Enable key backup so missing room keys can be fetched
        c.getCrypto()?.checkKeyBackupAndEnable().catch(() => {})
        resolve(getRooms(c))
      } else if (state === 'ERROR') {
        clearTimeout(timeout)
        c.off(sdk.ClientEvent.Sync, onSync)
        reject(new Error('Sync failed'))
      }
    }

    c.on(sdk.ClientEvent.Sync, onSync)
    c.startClient({ lazyLoadMembers: true })
  })
}
