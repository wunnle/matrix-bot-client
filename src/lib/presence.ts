/**
 * Tells the push gateway that a Construct client is in the foreground, so it
 * can skip buzzing the phone for a message you're already looking at somewhere
 * else (see clientActiveWithin in api/live-activity.js).
 *
 * Only while genuinely visible: the whole point is that a backgrounded tab or a
 * suspended app must NOT keep notifications muted. The server window is a
 * little longer than this interval so a missed beat doesn't flap.
 */
const BEAT_MS = 45_000

let timer: ReturnType<typeof setInterval> | null = null
let currentRoomId: string | null = null
let pushkey: string | null = null

/** Identity for a client that has no pushkey — a browser where notifications
    were never enabled still has to be recognisable as "somewhere else", or the
    phone keeps buzzing while you read on the desktop. Any value that can't
    collide with a real pushkey does; it only ever has to differ. */
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
      // The pushkey is how the gateway tells *this* device from the others: it
      // is the same value the homeserver hands it per device. Without one it
      // can't be identified, and the gateway deliberately does nothing rather
      // than guess (see matrix-push.js).
      body: JSON.stringify({ action: 'heartbeat', roomId: currentRoomId, pushkey: pushkey ?? clientId() }),
    })
  } catch {
    // Never surface: failing to report presence only means you get notified.
  }
}

/** This client's own pushkey (APNs token, or the web-push subscription JSON),
    so the gateway can recognise which device is the active one. */
export function setPresencePushkey(value: string | null) {
  pushkey = value
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
