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

const BEAT_MS = 45_000

let timer: ReturnType<typeof setInterval> | null = null
let currentRoomId: string | null = null
let pushkey: string | null = null

/** Stable identity for this install, and the *only* thing the gateway keys
    heartbeats by. Deliberately not the pushkey: on iOS the APNs token arrives
    several round-trips after the first beat, so keying by pushkey left the
    phone with two entries — a pushkey-less ghost plus the real token — and the
    ghost read as "another device you're reading on", muting the phone's own
    notifications and its Live Activity. One id per install means an
    unknown → token transition updates one entry instead of adding a second. */
function clientId(): string {
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

async function beat() {
  const secret = import.meta.env.VITE_INTENT_SECRET
  // Builds without the secret (the public one) simply never suppress.
  if (!secret || document.visibilityState !== 'visible') return
  try {
    await fetch('/api/live-activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intent-secret': secret },
      // clientId identifies the entry; pushkey (once known) is how the gateway
      // tells *this* device from the others, since it is the same value the
      // homeserver hands it per device. It is null until registration finishes,
      // and `native` is what stops that window muting the phone: an
      // unidentifiable native client is assumed to be the phone being notified
      // rather than another screen (see api/matrix-push.js).
      body: JSON.stringify({
        action: 'heartbeat',
        roomId: currentRoomId,
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

/** Which room is on screen, sent with the next beat. */
export function setActiveRoom(roomId: string | null) {
  currentRoomId = roomId
}

/** Start reporting foreground presence. Safe to call more than once. */
export function startPresenceHeartbeat(): () => void {
  if (timer) return () => {}
  void beat()
  timer = setInterval(() => void beat(), BEAT_MS)
  // Beat immediately on becoming visible too, so notifications go quiet as soon
  // as you switch back rather than up to one interval later.
  const onVisible = () => { if (document.visibilityState === 'visible') void beat() }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    if (timer) { clearInterval(timer); timer = null }
    document.removeEventListener('visibilitychange', onVisible)
  }
}
