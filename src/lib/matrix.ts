import * as sdk from 'matrix-js-sdk'
import type { AuthState } from '../types'

let client: sdk.MatrixClient | null = null
let initPromise: Promise<RoomSummary[]> | null = null

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
  initPromise = null
}

export interface RoomSummary {
  roomId: string
  name: string
  lastMessage?: string
  lastTs?: number
  unreadCount: number
  avatarMxc?: string
}

function getRooms(c: sdk.MatrixClient): RoomSummary[] {
  return c.getRooms()
    .filter((room) => {
      const createEvent = room.currentState.getStateEvents('m.room.create', '')
      return createEvent?.getContent()?.type !== 'm.space'
    })
    .map((room) => {
      const timeline = room.getLiveTimeline().getEvents()
      const last = [...timeline].reverse().find((e) => e.getType() === 'm.room.message')
      const avatarEvent = room.currentState.getStateEvents('m.room.avatar', '')
      const avatarMxc = avatarEvent?.getContent()?.url ?? undefined
      return {
        roomId: room.roomId,
        name: room.name,
        lastMessage: last?.getContent()?.body,
        lastTs: last?.getTs(),
        unreadCount: room.getUnreadNotificationCount(),
        avatarMxc,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Derive a stable 32-byte key deterministically from userId+deviceId.
// Simple hash instead of crypto.subtle (which requires HTTPS).
function getCryptoStorageKey(userId: string, deviceId: string): Uint8Array {
  const input = `matrix-pwa:${userId}:${deviceId}`
  const key = new Uint8Array(32)
  for (let i = 0; i < input.length; i++) {
    key[i % 32] = (key[i % 32]! * 31 + input.charCodeAt(i)) & 0xff
  }
  return key
}

async function wipeCryptoStores() {
  const dbs = await indexedDB.databases()
  await Promise.all(
    dbs
      .filter((db) => db.name?.includes('crypto'))
      .map((db) => new Promise<void>((res) => {
        const req = indexedDB.deleteDatabase(db.name!)
        req.onsuccess = () => res()
        req.onerror = () => res()
        req.onblocked = () => res()
      })),
  )
}

async function doInit(auth: AuthState): Promise<RoomSummary[]> {
  const c = createClient(auth)
  const storageKey = getCryptoStorageKey(auth.userId, auth.deviceId)

  try {
    await c.initRustCrypto({ storageKey })
  } catch (e) {
    console.warn('E2EE init failed, wiping crypto stores and retrying:', e)
    await wipeCryptoStores()
    // Reuse the same client — creating a new one would overwrite the
    // module-level `client` and leave consumers holding a stale reference
    await c.initRustCrypto({ storageKey })
  }

  return new Promise<RoomSummary[]>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync timed out')), 30000)

    const onSync = (state: string) => {
      if (state === 'PREPARED' || state === 'SYNCING') {
        clearTimeout(timeout)
        c.off(sdk.ClientEvent.Sync, onSync)
        c.getCrypto()?.checkKeyBackupAndEnable().catch(() => {})
        const rooms = getRooms(c)
        setCachedRooms(auth.userId, rooms)
        resolve(rooms)
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

const ROOM_ORDER_KEY = (userId: string) => `construct:room-order:${userId}`

export function getRoomOrder(userId: string): string[] | null {
  try {
    const raw = localStorage.getItem(ROOM_ORDER_KEY(userId))
    return raw ? (JSON.parse(raw) as string[]) : null
  } catch {
    return null
  }
}

export function setRoomOrder(userId: string, order: string[]) {
  try {
    localStorage.setItem(ROOM_ORDER_KEY(userId), JSON.stringify(order))
  } catch {}
}

export function applyRoomOrder(rooms: RoomSummary[], order: string[]): RoomSummary[] {
  const orderMap = new Map(order.map((id, i) => [id, i]))
  return [...rooms].sort((a, b) => {
    const ai = orderMap.get(a.roomId) ?? Infinity
    const bi = orderMap.get(b.roomId) ?? Infinity
    if (ai !== bi) return ai - bi
    return a.name.localeCompare(b.name)
  })
}

const ROOMS_CACHE_KEY = (userId: string) => `construct:rooms:${userId}`

export function getCachedRooms(userId: string): RoomSummary[] | null {
  try {
    const raw = localStorage.getItem(ROOMS_CACHE_KEY(userId))
    return raw ? (JSON.parse(raw) as RoomSummary[]) : null
  } catch {
    return null
  }
}

function setCachedRooms(userId: string, rooms: RoomSummary[]) {
  try {
    localStorage.setItem(ROOMS_CACHE_KEY(userId), JSON.stringify(rooms))
  } catch {}
}

export function fetchJoinedRooms(auth: AuthState): Promise<RoomSummary[]> {
  // Dedupe: React Strict Mode double-invokes effects in dev. Returning the
  // same promise prevents a second call from overwriting the module-level
  // client mid-crypto-init and racing on the shared IndexedDB stores.
  if (initPromise) return initPromise
  initPromise = doInit(auth).catch((e) => {
    initPromise = null
    throw e
  })
  return initPromise
}
