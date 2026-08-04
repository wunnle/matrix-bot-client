import * as sdk from 'matrix-js-sdk'
import type { AuthState } from '../types'

let client: sdk.MatrixClient | null = null
let initPromise: Promise<RoomSummary[]> | null = null

export function getClient(): sdk.MatrixClient {
  if (!client) throw new Error('Matrix client not initialized')
  return client
}

/**
 * Force an immediate sync catch-up — call on app foreground. iOS suspends the
 * WebView, killing the in-flight /sync long-poll; without this the SDK waits out
 * a timeout + backoff before recovering, so the UI shows stale (cached) state
 * for seconds after opening. retryImmediately() short-circuits that wait. No-op
 * (returns false) if the client isn't started or the sync is already healthy.
 */
export function resyncNow(): boolean {
  try {
    return client?.retryImmediately() ?? false
  } catch {
    return false
  }
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
  // Absent in caches written before invites were supported — treat as 'join'.
  membership?: 'join' | 'invite'
  // Who sent the invite, for 'invite' rooms only.
  invitedBy?: string
}

export function isInvite(room: RoomSummary): boolean {
  return room.membership === 'invite'
}

export async function acceptInvite(roomId: string): Promise<void> {
  await getClient().joinRoom(roomId)
}

export async function declineInvite(roomId: string): Promise<void> {
  await getClient().leave(roomId)
}

// Count unread messages using the local read receipt position rather than
// the server-side notification count, which can stay stale across restarts.
export function getRoomUnreadCount(room: sdk.Room, userId: string): number {
  const readUpTo = room.getEventReadUpTo(userId)
  const timeline = room.getLiveTimeline().getEvents()
  if (!readUpTo) {
    return timeline.filter(
      e => e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted'
    ).length
  }
  const readIdx = timeline.findIndex(e => e.getId() === readUpTo)
  if (readIdx === -1) {
    // Receipt points to an event not in the local timeline — fall back
    return room.getUnreadNotificationCount()
  }
  return timeline.slice(readIdx + 1).filter(
    e => e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted'
  ).length
}

function getRooms(c: sdk.MatrixClient, userId: string): RoomSummary[] {
  return c.getRooms()
    .filter((room) => {
      const createEvent = room.currentState.getStateEvents('m.room.create', '')
      if (createEvent?.getContent()?.type === 'm.space') return false
      const membership = room.getMyMembership()
      return membership === 'join' || membership === 'invite'
    })
    .map((room) => toRoomSummary(room, userId))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// The room list as it stands right now, for callers that need to re-derive it
// rather than trust a snapshot taken at startup.
export function toRoomSummaries(c: sdk.MatrixClient, userId: string): RoomSummary[] {
  return getRooms(c, userId)
}

export function toRoomSummary(room: sdk.Room, userId: string): RoomSummary {
  const invited = room.getMyMembership() === 'invite'
  const timeline = room.getLiveTimeline().getEvents()
  const last = [...timeline].reverse().find((e) => e.getType() === 'm.room.message')
  const avatarEvent = room.currentState.getStateEvents('m.room.avatar', '')
  const avatarMxc = avatarEvent?.getContent()?.url ?? undefined
  return {
    roomId: room.roomId,
    name: room.name,
    lastMessage: invited ? undefined : last?.getContent()?.body,
    lastTs: invited ? undefined : last?.getTs(),
    // An unjoined room has no readable timeline, so a count would be meaningless.
    unreadCount: invited ? 0 : getRoomUnreadCount(room, userId),
    avatarMxc,
    membership: invited ? 'invite' : 'join',
    invitedBy: invited
      ? room.currentState.getStateEvents('m.room.member', userId)?.getSender()
      : undefined,
  }
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

async function wipeIndexedDbs(filter: (name: string) => boolean) {
  const dbs = await indexedDB.databases()
  await Promise.all(
    dbs
      .filter((db) => db.name && filter(db.name))
      .map((db) => new Promise<void>((res) => {
        const req = indexedDB.deleteDatabase(db.name!)
        req.onsuccess = () => res()
        req.onerror = () => res()
        req.onblocked = () => res()
      })),
  )
}

async function wipeCryptoStores() {
  await wipeIndexedDbs((name) => name.includes('crypto'))
}

export async function destroyAndWipeStores(userId: string) {
  destroyClient()
  await wipeIndexedDbs((name) => name.includes('crypto') || name.startsWith(`construct:store:${userId}`))
  localStorage.removeItem(`construct:rooms:${userId}`)
}

async function doInit(auth: AuthState): Promise<RoomSummary[]> {
  // Persist room timeline to IndexedDB so subsequent loads skip the full sync wait
  let s: sdk.IndexedDBStore | null = null
  try {
    s = new sdk.IndexedDBStore({
      indexedDB: window.indexedDB,
      dbName: `construct:store:${auth.userId}`,
      localStorage: window.localStorage,
    })
    await s.startup()
  } catch (e) {
    console.warn('IndexedDB store init failed, falling back to in-memory:', e)
    s = null
  }
  client = sdk.createClient({
    baseUrl: auth.homeserver,
    accessToken: auth.accessToken,
    userId: auth.userId,
    deviceId: auth.deviceId,
    // Required for getEventTimeline (/context); defaults to false otherwise.
    timelineSupport: true,
    ...(s ? { store: s } : {}),
  })
  const c = client

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
        const rooms = getRooms(c, auth.userId)
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

/** Keep the cold-start snapshot current. Without this the cache only ever held
    the list as it looked at the previous launch's PREPARED — which comes from
    the persisted store, so invites and rooms created on another device stayed
    invisible on first paint until a sync landed. */
export function cacheRooms(userId: string, rooms: RoomSummary[]) {
  setCachedRooms(userId, rooms)
}

function setCachedRooms(userId: string, rooms: RoomSummary[]) {
  try {
    localStorage.setItem(ROOMS_CACHE_KEY(userId), JSON.stringify(rooms))
  } catch {}
}

export function fetchJoinedRooms(auth: AuthState): Promise<RoomSummary[]> {
  // Dedupe: React Strict Mode double-invokes effects in dev. Reusing the same
  // promise prevents a second call from overwriting the module-level client
  // mid-crypto-init and racing on the shared IndexedDB stores.
  //
  // But only the *initialisation* is deduped, not its result: that resolved to
  // the room list as it was at startup, so a later remount (navigating back
  // from a chat) re-rendered a stale snapshot and any invite that had arrived
  // since stayed invisible until a full reload. Recompute from the live client.
  if (initPromise) {
    return initPromise.then((initial) => {
      if (!client) return initial
      const rooms = getRooms(client, auth.userId)
      setCachedRooms(auth.userId, rooms)
      return rooms
    })
  }
  initPromise = doInit(auth).catch((e) => {
    initPromise = null
    throw e
  })
  return initPromise
}
