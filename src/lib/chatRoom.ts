import * as sdk from 'matrix-js-sdk'
import { shortName } from './chatFormat'

const SCROLLBACK_RETRIES = 3

// The SDK does not retry scrollback, so a single failed /messages, a 429 from
// matrix.org or a request lost on a socket iOS killed while suspended, used to
// end a room's history. Retry with the SDK's own policy: wait what a 429 asks
// for, back off on network and server errors, give up on other 4xx.
export async function scrollbackWithRetry(client: sdk.MatrixClient, room: sdk.Room, limit: number): Promise<sdk.Room> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.scrollback(room, limit)
    } catch (err) {
      const e = err as { httpStatus?: number; errcode?: string; name?: string }
      console.warn(`[scrollback] ${room.roomId} attempt ${attempt} failed:`, e.httpStatus ?? e.name, e.errcode ?? '')
      const wait = attempt > SCROLLBACK_RETRIES ? -1 : sdk.calculateRetryBackoff(err, attempt, true)
      if (wait < 0) throw err
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

export function getRoomBotMeta(roomId: string, userId: string, client: sdk.MatrixClient): { name: string; mxcUrl: string | null } | null {
  const room = client.getRoom(roomId)
  if (!room) return null
  const others = room.getMembersWithMembership('join').filter(m => m.userId !== userId)
  if (others.length === 0) return null
  const m = others[0]
  return { name: m.name ?? shortName(m.userId), mxcUrl: m.getMxcAvatarUrl() ?? null }
}

// Agent room topics are ` · `-separated, and their first field is where the
// room works: an absolute path for a plain room, a branch name for one running
// in its own worktree. A full path never fits the subtitle line, so keep only
// its last segment — the directory or worktree name is what identifies it.
// Branches pass through untouched, being short and already meaningful.
export function shortenTopicPaths(topic: string): string {
  return topic
    .split(' · ')
    .map((part) => (part.startsWith('/') ? part.split('/').filter(Boolean).pop() ?? part : part))
    .join(' · ')
}

/** Whether messages to this room are megolm-encrypted. Asks the crypto module
 *  (which also knows about rooms whose encryption state it has pinned), and
 *  falls back to the room's own state when crypto isn't up. */
export async function roomIsEncrypted(client: sdk.MatrixClient, roomId: string): Promise<boolean> {
  try {
    const crypto = client.getCrypto()
    if (crypto) return await crypto.isEncryptionEnabledInRoom(roomId)
  } catch {
    // fall through to room state
  }
  return client.getRoom(roomId)?.hasEncryptionStateEvent() ?? false
}
