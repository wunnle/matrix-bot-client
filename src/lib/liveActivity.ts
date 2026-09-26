import { Capacitor, registerPlugin } from '@capacitor/core'
import { getClient, intentCredential } from './matrix'
import { resolveMediaBase64 } from './mediaUrl'

/**
 * Live Activity (Dynamic Island / lock screen) bridge — native iOS only.
 * Implemented by LiveActivityPlugin in ios/App/App/AppDelegate.swift.
 *
 * Pass a roomId when starting: the native side registers the activity's APNs
 * push token against that room, which is what lets api/matrix-push.js update
 * the activity once the app is suspended. Without it the activity still works,
 * but can only be updated while the app is running.
 */
interface LiveActivityPlugin {
  isSupported(): Promise<{ supported: boolean }>
  // roomId is what lets the native side register the activity's push token
  // against a room; without it the activity can only be updated in-app.
  start(options: { roomName: string; status: string; detail?: string; roomId?: string; question?: string }): Promise<{ activityId: string }>
  update(options: { status: string; detail?: string; question?: string }): Promise<void>
  end(options?: { roomId?: string }): Promise<void>
  saveIntentConfig(options: { secret: string; apiBase: string; room: string }): Promise<void>
  donateShareTargets(options: { rooms: { roomId: string; name: string; avatar?: string }[]; remove?: string[] }): Promise<void>
  // Separate from the donation above: the Live Activity needs an avatar on disk
  // for *every* room, not just the ones enabled for sharing.
  cacheRoomAvatars(options: { rooms: { roomId: string; avatar: string }[] }): Promise<void>
  isMacApp(): Promise<{ value: boolean }>
}

const plugin = registerPlugin<LiveActivityPlugin>('LiveActivity')

/**
 * Hand the background "Ask Construct" App Intent what it needs (it runs
 * without the webview): its API credential, API base, and default room.
 * The credential is the signed-in Matrix access token (see intentCredential);
 * the native side sends it as `x-intent-secret` unchanged. Call once on
 * launch, after login. No-op off native or before login.
 */
export async function saveIntentConfig(room: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const secret = intentCredential()
  if (!secret) return
  await plugin.saveIntentConfig({
    secret,
    apiBase: 'https://construct.kafagoz.com',
    room,
  }).catch(() => {})
}

/**
 * Donate the user's rooms as direct-share targets so they appear (with names)
 * in the share sheet's suggestions row. The Share Extension reads the picked
 * room from the intent. No-op off native.
 */
export async function donateShareTargets(
  rooms: { roomId: string; name: string; avatarMxc?: string }[],
  removeRoomIds: string[] = [],
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  let client: ReturnType<typeof getClient> | null
  try { client = getClient() } catch { client = null }
  const payload = await Promise.all(rooms.slice(0, 12).map(async r => ({
    roomId: r.roomId,
    name: r.name,
    avatar: client && r.avatarMxc
      ? (await resolveMediaBase64(client, r.avatarMxc, 96, 96, 'crop')) ?? undefined
      : undefined,
  })))
  await plugin.donateShareTargets({ rooms: payload, remove: removeRoomIds }).catch(() => {})
}

/**
 * Cache every room's avatar where the Live Activity can read it. It renders
 * without network access, so the image has to be on disk before a message
 * arrives — and unlike donateShareTargets this covers all rooms, since what the
 * lock screen can draw shouldn't depend on the share-sheet settings.
 */
export async function cacheRoomAvatars(
  rooms: { roomId: string; avatarMxc?: string }[],
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  let client: ReturnType<typeof getClient> | null
  try { client = getClient() } catch { return }
  if (!client) return
  const withAvatars = rooms.filter(r => r.avatarMxc).slice(0, 50)
  if (withAvatars.length === 0) return
  const resolved = await Promise.all(withAvatars.map(async r => {
    const avatar = await resolveMediaBase64(client!, r.avatarMxc!, 96, 96, 'crop')
    return avatar ? { roomId: r.roomId, avatar } : null
  }))
  // Explicit guard: filter(Boolean) doesn't narrow away the nulls for tsc.
  const payload = resolved.filter((r): r is { roomId: string; avatar: string } => r !== null)
  if (payload.length === 0) return
  await plugin.cacheRoomAvatars({ rooms: payload }).catch(() => {})
}

/** True when running as an iPad app on a Mac (Designed for iPad). */
export async function isMacApp(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  try {
    return (await plugin.isMacApp()).value
  } catch {
    return false
  }
}

/** Raw plugin access — errors propagate. For diagnostics/tests. */
export const liveActivityPlugin = plugin

/** Whether Live Activities can run — native platform, iOS 16.2+, and enabled in Settings. */
export async function liveActivitySupported(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  try {
    const { supported } = await plugin.isSupported()
    return supported
  } catch {
    return false
  }
}

/** Room the current activity belongs to, so end() can clear its push token. */
let currentRoomId: string | null = null
/** The user's message, shown faded above the reply and kept across updates. */
let currentQuestion = ''

export async function startLiveActivity(roomName: string, status: string, detail = '', roomId?: string, question = ''): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null
  try {
    currentRoomId = roomId ?? null
    currentQuestion = question
    const { activityId } = await plugin.start({ roomName, status, detail, roomId, question })
    return activityId
  } catch {
    return null
  }
}

export async function updateLiveActivity(status: string, detail = ''): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  // Carry the question forward so an update doesn't wipe it.
  await plugin.update({ status, detail, question: currentQuestion }).catch(() => {})
}

export async function endLiveActivity(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const roomId = currentRoomId ?? undefined
  currentRoomId = null
  await plugin.end({ roomId }).catch(() => {})
}
