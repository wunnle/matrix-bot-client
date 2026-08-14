// Spawning an agent room from the home screen instead of typing `!spawn`.
//
// The bot has no API — the command is just a message — so this sends `!spawn`
// into a room the bot is already in and waits for the invite it sends back.

import * as sdk from 'matrix-js-sdk'
import { isAgentRoom } from './roomMeta'

// How long to wait for the bot's invite before giving up. A spawn cuts a git
// worktree first, which on a cold page cache is seconds rather than instant.
const INVITE_TIMEOUT_MS = 90_000

/**
 * A joined room the bot listens in, or null when there is none. Agent rooms are
 * the reliable signal: the bot created them, so it is certainly a member and
 * certainly still handling commands there. The most recently active one wins —
 * it is the room the user is most likely to look at if something goes wrong,
 * and the spawn's confirmation lands there.
 */
export function findSpawnHostRoom(client: sdk.MatrixClient): string | null {
  const candidates = client.getRooms()
    .filter((r) => r.getMyMembership() === 'join' && isAgentRoom(client, r.roomId))
    .sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp())
  return candidates[0]?.roomId ?? null
}

/**
 * Sends `!spawn` to `hostRoomId` and resolves with the room id of the invite the
 * bot sends back. Rejects if no invite arrives in time — the command itself is
 * fire-and-forget, so a timeout means "look at the host room", not "nothing
 * happened".
 */
export async function spawnAgentRoom(
  client: sdk.MatrixClient,
  hostRoomId: string,
): Promise<string> {
  // Subscribed before the send, not after: the bot can invite faster than the
  // send's own round trip returns, and an invite that lands first is missed.
  const invited = waitForInvite(client)
  try {
    await client.sendMessage(hostRoomId, { msgtype: 'm.text', body: '!spawn' } as never)
  } catch (e) {
    invited.cancel()
    throw e
  }
  return invited.promise
}

function waitForInvite(client: sdk.MatrixClient): { promise: Promise<string>, cancel: () => void } {
  let cancel = () => {}
  const promise = new Promise<string>((resolve, reject) => {
    const onMembership = (room: sdk.Room, membership: string) => {
      if (membership !== 'invite') return
      stop()
      resolve(room.roomId)
    }
    const timer = setTimeout(() => {
      stop()
      reject(new Error('The bot did not send an invite. Check the room you spawned from.'))
    }, INVITE_TIMEOUT_MS)
    function stop() {
      clearTimeout(timer)
      client.off(sdk.RoomEvent.MyMembership, onMembership)
    }
    client.on(sdk.RoomEvent.MyMembership, onMembership)
    cancel = () => { stop(); reject(new Error('cancelled')) }
  })
  // The cancel path's rejection is never awaited — the caller throws its own
  // error instead — so absorb it rather than tripping unhandled-rejection.
  promise.catch(() => {})
  return { promise, cancel: () => cancel() }
}
