// The bot's half of notifications in encrypted rooms. matrix.org can't read a
// megolm message, so its push to the gateway has no text; the bot, which just
// encrypted it, hands the plaintext to the gateway instead
// (api/_bot-push.js, served at /api/matrix-push?from=bot), which formats and
// delivers it the same way as any other notification.
//
// Auth is CONSTRUCT_INTENT_SECRET, from the bot's env or ~/.hermes/.env like
// construct-activity. Best effort throughout: a failed push is logged, never
// thrown, because the message itself is already in the room.
import fs from 'node:fs'
import os from 'node:os'

const API = process.env.CONSTRUCT_PUSH_API ?? 'https://construct.kafagoz.com/api/matrix-push?from=bot'
const ENV_FILE = `${os.homedir()}/.hermes/.env`

let cachedSecret
function secret() {
  if (cachedSecret !== undefined) return cachedSecret
  cachedSecret = process.env.CONSTRUCT_INTENT_SECRET?.trim() || null
  if (!cachedSecret) {
    try {
      const text = fs.readFileSync(ENV_FILE, 'utf8')
      cachedSecret = text.match(/^CONSTRUCT_INTENT_SECRET=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || null
    } catch {
      cachedSecret = null
    }
  }
  return cachedSecret
}

/** Content that never notifies anyway (the gateway drops it too), so the
    round trip is skipped: tool progress and other machine messages. */
export function wantsPush(content) {
  return typeof content?.body === 'string' && !!content.body.trim() && !content['com.construct.machine']
}

/**
 * Asks the gateway to notify for an event this bot just sent to an encrypted
 * room. Resolves to the gateway's JSON reply, or `{ sent: false, error }`.
 */
export async function notifyEncrypted({ roomId, eventId, content, roomName, log = () => {} }) {
  if (!wantsPush(content)) return { sent: false, reason: 'not notifiable' }
  const key = secret()
  if (!key) {
    log('Encrypted-room push skipped: no CONSTRUCT_INTENT_SECRET')
    return { sent: false, error: 'no secret' }
  }
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intent-secret': key },
      // Only what a notification is made of. Never the whole event: an image's
      // content.file carries its decryption key, which has no business leaving
      // the room.
      body: JSON.stringify({
        room_id: roomId,
        event_id: eventId,
        content: { msgtype: content.msgtype, body: content.body },
        room_name: roomName || undefined,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const reply = await res.json().catch(() => ({}))
    if (!res.ok) log(`Encrypted-room push for ${eventId} failed: HTTP ${res.status} ${reply.error ?? ''}`)
    return res.ok ? reply : { sent: false, error: reply.error ?? `HTTP ${res.status}` }
  } catch (e) {
    log(`Encrypted-room push for ${eventId} failed: ${e.message}`)
    return { sent: false, error: e.message }
  }
}
