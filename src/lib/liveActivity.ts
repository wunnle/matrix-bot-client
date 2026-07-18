import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Live Activity (Dynamic Island / lock screen) bridge — native iOS only.
 * Implemented by LiveActivityPlugin in ios/App/App/AppDelegate.swift.
 *
 * Activities started here are local: they can be updated only while the app
 * is running. Updating a backgrounded activity needs APNs liveactivity
 * pushes, which require paid Developer Program enrollment (see TODO.md).
 */
interface LiveActivityPlugin {
  isSupported(): Promise<{ supported: boolean }>
  start(options: { roomName: string; status: string; detail?: string }): Promise<{ activityId: string }>
  update(options: { status: string; detail?: string }): Promise<void>
  end(): Promise<void>
}

const plugin = registerPlugin<LiveActivityPlugin>('LiveActivity')

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

export async function startLiveActivity(roomName: string, status: string, detail = ''): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null
  try {
    const { activityId } = await plugin.start({ roomName, status, detail })
    return activityId
  } catch {
    return null
  }
}

export async function updateLiveActivity(status: string, detail = ''): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  await plugin.update({ status, detail }).catch(() => {})
}

export async function endLiveActivity(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  await plugin.end().catch(() => {})
}

/* ── Dictation → reply flow ──────────────────────────────────────────────
   After a dictated message auto-sends, show "Waiting for reply…" in the
   Dynamic Island; the next incoming message in that room becomes the
   reply shown there. Only updates while the app is alive — background
   updates need APNs liveactivity pushes (post-enrollment). */

let awaitingRoomId: string | null = null
let endTimer: ReturnType<typeof setTimeout> | null = null

export async function startAwaitingReply(roomId: string, roomName: string, question: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  awaitingRoomId = roomId
  if (endTimer) { clearTimeout(endTimer); endTimer = null }
  await endLiveActivity()
  await startLiveActivity(roomName, 'Waiting for reply…', question.slice(0, 80))
}

/** Feed incoming room messages; the first one for the awaited room becomes the island reply. */
export function maybeShowReply(roomId: string, body: string): void {
  if (!Capacitor.isNativePlatform() || awaitingRoomId !== roomId || !body) return
  awaitingRoomId = null
  void updateLiveActivity('Reply', body.slice(0, 120))
  endTimer = setTimeout(() => { void endLiveActivity() }, 25_000)
}
