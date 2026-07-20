import { Capacitor, registerPlugin } from '@capacitor/core'

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

type Phase = 'idle' | 'listening' | 'awaiting' | 'replied'
let phase: Phase = 'idle'
let hasActivity = false
let awaitingRoomId: string | null = null
let awaitingSince = 0
let endTimer: ReturnType<typeof setTimeout> | null = null
let replyWindowTimer: ReturnType<typeof setTimeout> | null = null
let lastTranscriptAt = 0

/** How long after the last reply we keep listening for follow-up messages. */
const REPLY_WINDOW_MS = 30_000
/** How long the finished activity lingers on the lock screen. */
const LINGER_MS = 10 * 60_000

/** The room currently awaiting a reply, and when the wait began (ms). */
export function awaitingReply(): { roomId: string; since: number } | null {
  return phase === 'awaiting' && awaitingRoomId ? { roomId: awaitingRoomId, since: awaitingSince } : null
}

function clearEndTimer() {
  if (endTimer) { clearTimeout(endTimer); endTimer = null }
}

/** Dictation started — open a "Listening…" activity. */
export async function startListening(roomName: string, roomId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  clearEndTimer()
  phase = 'listening'
  awaitingRoomId = null
  await endLiveActivity()
  hasActivity = true
  lastTranscriptAt = 0
  await startLiveActivity(roomName, 'Listening…', '', roomId)
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
  // The question now lives in its own field (shown faded) rather than in the
  // detail line, so it survives once the reply fills detail in.
  const q = question.slice(0, 120)
  currentQuestion = q
  if (hasActivity) {
    await updateLiveActivity('Waiting for reply…', '')
  } else {
    hasActivity = true
    await startLiveActivity(roomName, 'Waiting for reply…', '', roomId, q)
  }
}

/* Streamed edits can arrive several times a second; iOS rate-limits Live
   Activity updates, so throttle to ~1/s with a trailing update so the final
   text always lands. */
let lastReplyUpdateAt = 0
let pendingReplyBody: string | null = null
let replyUpdateTimer: ReturnType<typeof setTimeout> | null = null

function pushReplyUpdate(body: string): void {
  const now = Date.now()
  const elapsed = now - lastReplyUpdateAt
  if (elapsed >= 900) {
    lastReplyUpdateAt = now
    void updateLiveActivity('Reply', body.slice(0, 160))
    return
  }
  pendingReplyBody = body
  if (!replyUpdateTimer) {
    replyUpdateTimer = setTimeout(() => {
      replyUpdateTimer = null
      lastReplyUpdateAt = Date.now()
      if (pendingReplyBody) void updateLiveActivity('Reply', pendingReplyBody.slice(0, 160))
      pendingReplyBody = null
    }, 900 - elapsed)
  }
}

/** Feed incoming room messages. Each message for the awaited room updates the
    island; follow-ups keep landing for REPLY_WINDOW_MS after the last one. */
export function maybeShowReply(roomId: string, body: string): void {
  if (!Capacitor.isNativePlatform() || awaitingRoomId !== roomId || !body) return
  if (phase !== 'awaiting' && phase !== 'replied') return
  phase = 'replied'
  pushReplyUpdate(body)

  // Follow-up window: another bot message within 30s replaces the shown reply.
  if (replyWindowTimer) clearTimeout(replyWindowTimer)
  replyWindowTimer = setTimeout(() => {
    phase = 'idle'
    awaitingRoomId = null
  }, REPLY_WINDOW_MS)

  // Keep the finished activity visible for a while.
  clearEndTimer()
  endTimer = setTimeout(() => {
    hasActivity = false
    void endLiveActivity()
  }, LINGER_MS)
}
