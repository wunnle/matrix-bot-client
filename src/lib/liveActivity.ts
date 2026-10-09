import { Capacitor, registerPlugin } from '@capacitor/core'
import { getClient, intentCredential } from './matrix'
import { resolveMediaBase64 } from './mediaUrl'
import { API_ORIGIN } from './apiUrl'

/**
 * Live Activity (Dynamic Island / lock screen) bridge — native iOS only.
 * Implemented by LiveActivityPlugin in ios/App/App/AppDelegate.swift.
 *
 * Real activities are started by the server; start/update/end
 * here exist for the debug overlay to exercise the widget locally.
 */

export type LiveActivityTone = 'neutral' | 'success' | 'warning' | 'error'

export interface LiveActivityAction {
  label: string
  /** Text posted to roomId when the button is tapped. */
  send: string
}

/** Mirrors ConstructActivityAttributes.ContentState. */
export interface LiveActivityState {
  title?: string
  body?: string
  tone?: LiveActivityTone
  /** 0...1 */
  progress?: number
  /** e.g. "3/5" */
  step?: string
  /** At most 3; extras are dropped. */
  actions?: LiveActivityAction[]
  roomId?: string
  roomName?: string
  /** Unix seconds. */
  endsAt?: number
}

interface LiveActivityPlugin {
  isSupported(): Promise<{ supported: boolean }>
  // No activityId → a fresh one. An id already on screen is updated instead.
  start(options: LiveActivityState & { activityId?: string }): Promise<{ activityId: string }>
  // Merges into the activity's current state; omitted fields keep their value.
  update(options: LiveActivityState & { activityId: string }): Promise<void>
  // No activityId → ends every activity.
  end(options?: { activityId?: string }): Promise<void>
  saveIntentConfig(options: { secret: string; apiBase: string; room: string }): Promise<void>
  donateShareTargets(options: { rooms: { roomId: string; name: string; avatar?: string }[]; remove?: string[] }): Promise<void>
  // Separate from the donation above: the Live Activity needs an avatar on disk
  // for *every* room, not just the ones enabled for sharing.
  cacheRoomAvatars(options: { rooms: { roomId: string; avatar: string }[] }): Promise<void>
  isMacApp(): Promise<{ value: boolean }>
  macZoom(options: { step?: number }): Promise<{ zoom: number }>
  appIcon(): Promise<{ supported: boolean; name: string | null }>
  setAppIcon(options: { name: string | null }): Promise<void>
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
    apiBase: API_ORIGIN,
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

/** On the Mac: zoom the page one step in (1), out (-1) or back to standard
 *  (0); with no step, just read it. Resolves to the zoom now in effect. */
export async function macZoom(step?: 1 | -1 | 0): Promise<number | null> {
  try {
    return (await plugin.macZoom(step === undefined ? {} : { step })).zoom
  } catch {
    return null
  }
}

/** The home-screen icon: null when it can't be changed here (web, or a
 *  device without alternate icons); otherwise the alternate's name, or null
 *  for the default. */
export async function getAppIcon(): Promise<{ name: string | null } | null> {
  if (!Capacitor.isNativePlatform()) return null
  try {
    const { supported, name } = await plugin.appIcon()
    return supported ? { name: name ?? null } : null
  } catch {
    return null
  }
}

/** Switch the home-screen icon; null goes back to the default. iOS confirms
 *  with its own alert. */
export async function setAppIcon(name: string | null): Promise<void> {
  await plugin.setAppIcon({ name })
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
