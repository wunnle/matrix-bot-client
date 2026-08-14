// Spawning an agent room from the home screen instead of typing `!spawn`.
//
// The bot has no API — the command is just a message — so this sends `!spawn`
// into a room the bot is already in and waits for the invite it sends back.

import * as sdk from 'matrix-js-sdk'
import { isAgentRoom } from './roomMeta'

// How long to wait for the bot's invite before giving up. A spawn cuts a git
// worktree first, which on a cold page cache is seconds rather than instant.
const INVITE_TIMEOUT_MS = 90_000

// The standing room to spawn from — one the bot sits in that is not itself an
// agent room, so the tile works with no agent rooms open at all. It cannot be
// detected: the bot shares several ordinary rooms with the user (including
// public ones it was invited to), and picking the wrong one sends a command
// into a room full of strangers. So it is pinned, and overridable per deploy.
const CONFIGURED_HOST_ROOM: string =
  import.meta.env.VITE_SPAWN_ROOM ?? '!DpRWqhWOHJAxyvjOGI:matrix.org'

/**
 * A joined room the bot listens in, or null when there is none.
 *
 * The pinned room wins when it is joined — spawning from the room you already
 * use for this keeps the command out of whichever agent room happened to be
 * active. Agent rooms are the fallback: the bot created them, so it is
 * certainly a member and certainly still handling commands there. Most
 * recently active first, since that is where the user will look if the spawn
 * goes wrong and the confirmation lands there.
 */
export function findSpawnHostRoom(client: sdk.MatrixClient): string | null {
  if (client.getRoom(CONFIGURED_HOST_ROOM)?.getMyMembership() === 'join') {
    return CONFIGURED_HOST_ROOM
  }
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
  //
  // The snapshot is what makes "the invite" mean the new one. MyMembership
  // re-fires for invites that were already pending — an old un-accepted agent
  // room is enough — and taking the first event wholesale opened a stale room
  // while the freshly spawned one sat unaccepted in the list.
  const known = new Set(
    client.getRooms().filter((r) => r.getMyMembership() === 'invite').map((r) => r.roomId),
  )
  const invited = waitForInvite(client, known)
  try {
    await client.sendMessage(hostRoomId, { msgtype: 'm.text', body: '!spawn' } as never)
  } catch (e) {
    invited.cancel()
    throw e
  }
  return invited.promise
}

function waitForInvite(
  client: sdk.MatrixClient,
  known: Set<string>,
): { promise: Promise<string>, cancel: () => void } {
  let cancel = () => {}
  const promise = new Promise<string>((resolve, reject) => {
    const onMembership = (room: sdk.Room, membership: string) => {
      if (membership !== 'invite') return
      if (known.has(room.roomId)) return
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
