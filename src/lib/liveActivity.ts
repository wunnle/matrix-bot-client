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
  saveIntentConfig(options: { secret: string; apiBase: string; room: string }): Promise<void>
}

const plugin = registerPlugin<LiveActivityPlugin>('LiveActivity')

/**
 * Hand the background "Ask Construct" App Intent what it needs (it runs
 * without the webview): the intent secret, API base, and default room.
 * Call once on launch. No-op off native or without a secret.
 */
export async function saveIntentConfig(room: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const secret = import.meta.env.VITE_INTENT_SECRET
  if (!secret) return
  await plugin.saveIntentConfig({
    secret,
    apiBase: 'https://construct.kafagoz.com',
    room,
  }).catch(() => {})
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

/* ── Listen → reply flow (Dynamic Island) ────────────────────────────────
   Phase machine driven from ChatView while dictating on native:
     listening — live transcript shown as you speak (mic can start only in
                 foreground; the audio background mode keeps it running after
                 you swipe home)
     awaiting  — after auto-send, "Waiting for reply…"
     reply     — first incoming message in the room, then auto-dismiss

   All updates require the app process alive; the audio session (background
   mode) keeps it alive through the awaiting phase. Fully-closed updates
   still need APNs liveactivity pushes (post-enrollment). */

type Phase = 'idle' | 'listening' | 'awaiting'
let phase: Phase = 'idle'
let hasActivity = false
let awaitingRoomId: string | null = null
let awaitingSince = 0
let endTimer: ReturnType<typeof setTimeout> | null = null
let lastTranscriptAt = 0

/** The room currently awaiting a reply, and when the wait began (ms). */
export function awaitingReply(): { roomId: string; since: number } | null {
  return phase === 'awaiting' && awaitingRoomId ? { roomId: awaitingRoomId, since: awaitingSince } : null
}

function clearEndTimer() {
  if (endTimer) { clearTimeout(endTimer); endTimer = null }
}

/** Dictation started — open a "Listening…" activity. */
export async function startListening(roomName: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  clearEndTimer()
  phase = 'listening'
  awaitingRoomId = null
  await endLiveActivity()
  hasActivity = true
  lastTranscriptAt = 0
  await startLiveActivity(roomName, 'Listening…', '')
}

/** Live partial transcript — throttled; Live Activity updates are rate-limited. */
export function updateListeningTranscript(text: string): void {
  if (!Capacitor.isNativePlatform() || phase !== 'listening') return
  const now = Date.now()
  if (now - lastTranscriptAt < 400) return
  lastTranscriptAt = now
  void updateLiveActivity('Listening…', text.slice(-120))
}

/** Dictation ended without an auto-send (manual stop / auto-send off). */
export async function stopListening(): Promise<void> {
  if (!Capacitor.isNativePlatform() || phase !== 'listening') return
  phase = 'idle'
  hasActivity = false
  await endLiveActivity()
}

/** Dictated message auto-sent → wait for the reply in the island. */
export async function startAwaitingReply(roomId: string, roomName: string, question: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  clearEndTimer()
  phase = 'awaiting'
  awaitingRoomId = roomId
  awaitingSince = Date.now()
  const q = question.slice(0, 80)
  if (hasActivity) {
    await updateLiveActivity('Waiting for reply…', q)
  } else {
    hasActivity = true
    await startLiveActivity(roomName, 'Waiting for reply…', q)
  }
}

/** Feed incoming room messages; the first one for the awaited room becomes the island reply. */
export function maybeShowReply(roomId: string, body: string): void {
  if (!Capacitor.isNativePlatform() || phase !== 'awaiting' || awaitingRoomId !== roomId || !body) return
  phase = 'idle'
  awaitingRoomId = null
  void updateLiveActivity('Reply', body.slice(0, 160))
  clearEndTimer()
  endTimer = setTimeout(() => {
    hasActivity = false
    void endLiveActivity()
  }, 25_000)
}
