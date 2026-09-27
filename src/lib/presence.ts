/**
 * Tells the push gateway that a Construct client is in the foreground, so it
 * can skip buzzing the phone for a message you're already looking at somewhere
 * else (see clientActiveWithin in api/live-activity.js).
 *
 * Only while genuinely visible: the whole point is that a backgrounded tab or a
 * suspended app must NOT keep notifications muted. The server window is a
 * little longer than this interval so a missed beat doesn't flap.
 */
import { Capacitor } from '@capacitor/core'
import { intentCredential } from './matrix'
import { apiUrl } from './apiUrl'

const BEAT_MS = 45_000

let timer: ReturnType<typeof setInterval> | null = null
let currentRoomId: string | null = null
let pushkey: string | null = null
/** Last keyboard/pointer input. An open tab you walked away from stays
    "visible" for hours; this is what tells the gateway you're actually here. */
let lastInputAt = Date.now()

/** Stable identity for this install, and the *only* thing the gateway keys
    heartbeats by. Deliberately not the pushkey: on iOS the APNs token arrives
    several round-trips after the first beat, so keying by pushkey left the
    phone with two entries — a pushkey-less ghost plus the real token — and the
    ghost read as "another device you're reading on", muting the phone's own
    notifications and its Live Activity. One id per install means an
    unknown → token transition updates one entry instead of adding a second.
    Also tags this install's pusher, so re-registering only retires its own
    older rows (see api/register-pusher.js). */
export function clientId(): string {
  const KEY = 'construct:client-id'
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = `client:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return 'client:ephemeral'
  }
}

/** `leaving`: the app is going to the background. Reports it hidden, so this
    device stops being muted now rather than when the 75s server window runs
    out — otherwise locking the phone right after asking something swallowed
    the reply. keepalive lets the request outlive the page freezing. */
async function beat(leaving = false) {
  const secret = intentCredential()
  // Not signed in yet: nothing to report, and the gateway simply notifies.
  if (!secret || (!leaving && document.visibilityState !== 'visible')) return
  try {
    await fetch(apiUrl('/api/live-activity'), {
      method: 'POST',
      keepalive: leaving,
      headers: { 'content-type': 'application/json', 'x-intent-secret': secret },
      // clientId identifies the entry; pushkey (once known) is how the gateway
      // tells *this* device from the others, since it is the same value the
      // homeserver hands it per device. It is null until registration finishes,
      // and `native` is what stops that window muting the phone: an
      // unidentifiable native client is assumed to be the phone being notified
      // rather than another screen (see api/matrix-push.js).
      body: JSON.stringify({
        action: 'heartbeat',
        roomId: leaving ? null : currentRoomId,
        // A visible web client toasts messages for other rooms itself, so the
        // gateway skips its push entirely (api/matrix-push.js).
        visible: !leaving,
        // Relative, so the phone and laptop clocks never have to agree. Lets
        // the gateway quiet the phone for a room you're chatting in here.
        idleMs: Date.now() - lastInputAt,
        clientId: clientId(),
        pushkey,
        native: Capacitor.isNativePlatform(),
      }),
    })
  } catch {
    // Never surface: failing to report presence only means you get notified.
  }
}

/** This client's own pushkey (APNs token, or the web-push subscription JSON),
    so the gateway can recognise which device is the active one. */
export function setPresencePushkey(value: string | null) {
  const changed = pushkey !== value
  pushkey = value
  // Beat straight away rather than waiting up to BEAT_MS: until the gateway has
  // seen the pushkey it can't tell this device apart from the others, so it has
  // to fall back to "notify anyway" for every message in between.
  if (changed && timer) void beat()
}

/** Which room is on screen. Reported straight away: waiting for the next beat
    kept the old room muted, and the new one notifying, for up to BEAT_MS. */
export function setActiveRoom(roomId: string | null) {
  const changed = currentRoomId !== roomId
  currentRoomId = roomId
  if (changed && timer) void beat()
}

/** Start reporting foreground presence. Safe to call more than once. */
export function startPresenceHeartbeat(): () => void {
  if (timer) return () => {}
  void beat()
  timer = setInterval(() => void beat(), BEAT_MS)
  // Beat on every visibility change: becoming visible goes quiet straight away,
  // going hidden un-mutes the room straight away.
  const onVisibility = () => void beat(document.visibilityState !== 'visible')
  document.addEventListener('visibilitychange', onVisibility)
  // Coming back after a minute idle beats at once, so the phone goes quiet for
  // this room from your first keystroke rather than up to BEAT_MS later.
  const onInput = () => {
    const wasIdle = Date.now() - lastInputAt > 60_000
    lastInputAt = Date.now()
    if (wasIdle) void beat()
  }
  const INPUT_EVENTS = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const
  for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true })
  return () => {
    if (timer) { clearInterval(timer); timer = null }
    document.removeEventListener('visibilitychange', onVisibility)
    for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true })
  }
}
