// Spawning an agent room from the home screen instead of typing `!spawn`.
//
// The bot has no API — the command is just a message — so this sends `!spawn`
// into a room the bot is already in and waits for the invite it sends back.

import * as sdk from 'matrix-js-sdk'
import { isAgentRoom, isHiddenRoom, SPAWN_HOST_TYPE } from './roomMeta'
import { spawnCommand, type AgentProvider } from './spawnCommand'

// How long to wait for the bot's invite before giving up. A spawn cuts a git
// worktree first, which on a cold page cache is seconds rather than instant.
const INVITE_TIMEOUT_MS = 90_000
// How long a freshly created spawn room waits for the bot to join it.
const HOST_JOIN_TIMEOUT_MS = 20_000

// The standing room to spawn from on matrix.org, where the Bender room already
// plays that part. Overridable per deploy.
const CONFIGURED_HOST_ROOM: string =
  import.meta.env.VITE_SPAWN_ROOM ?? '!DpRWqhWOHJAxyvjOGI:matrix.org'

// Account data naming this account's own spawn room ({ room_id }). Account data
// is per account, so each homeserver gets its own room with no configuration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SPAWN_ROOM_ACCOUNT_DATA = 'com.construct.spawn_room' as any

function joined(client: sdk.MatrixClient, roomId: string | undefined | null): roomId is string {
  return !!roomId && client.getRoom(roomId)?.getMyMembership() === 'join'
}

function savedHostRoom(client: sdk.MatrixClient): string | null {
  const id = client.getAccountData(SPAWN_ROOM_ACCOUNT_DATA)?.getContent<{ room_id?: string }>()?.room_id
  return joined(client, id) ? id : null
}

/** The agent bot as seen from this account: whoever created its newest agent room. */
function agentBot(client: sdk.MatrixClient): string | null {
  const newest = client.getRooms()
    .filter((r) => r.getMyMembership() === 'join' && isAgentRoom(client, r.roomId))
    .sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp())[0]
  return newest?.currentState.getStateEvents('m.room.create', '')?.getSender() ?? null
}

/**
 * Whether spawning can work: there is a spawn room already, or an agent bot to
 * open one with. Synchronous, for deciding whether to offer the button.
 */
export function canSpawnFrom(client: sdk.MatrixClient): boolean {
  return savedHostRoom(client) !== null || joined(client, CONFIGURED_HOST_ROOM) || agentBot(client) !== null
}

/**
 * The room to send `!spawn` into, created on first use.
 *
 * Commands used to fall back to the most recently active agent room, which on
 * a server without the pinned room put a stray `!spawn` (and the bot's reply)
 * into whatever conversation you had open last. Now each account gets one
 * private room with the bot, hidden from the room list and muted, remembered
 * in account data so every device uses the same one.
 */
export async function ensureSpawnHostRoom(client: sdk.MatrixClient): Promise<string | null> {
  const saved = savedHostRoom(client)
  if (saved) return saved
  if (joined(client, CONFIGURED_HOST_ROOM)) return CONFIGURED_HOST_ROOM
  const bot = agentBot(client)
  if (!bot) return null
  const { room_id } = await client.createRoom({
    name: 'Agent spawner',
    topic: 'Construct sends !spawn here. Hidden from the room list.',
    preset: sdk.Preset.PrivateChat,
    visibility: sdk.Visibility.Private,
    invite: [bot],
    creation_content: { type: SPAWN_HOST_TYPE },
  })
  // The bot's "Spawned a room…" receipts land here; nobody needs a push for them.
  client.addPushRule('global', sdk.PushRuleKind.RoomSpecific, room_id, { actions: [] })
    .catch((e) => console.warn('Could not mute the spawn room:', e))
  await client.setAccountData(SPAWN_ROOM_ACCOUNT_DATA, { room_id } as never)
  // A command sent before the bot joins is never seen by it.
  const deadline = Date.now() + HOST_JOIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const members = await client.getJoinedRoomMembers(room_id).catch(() => null)
    if (members?.joined?.[bot]) return room_id
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('The agent bot did not join the spawn room. Try again in a moment.')
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
  provider: AgentProvider = 'claude',
  // The bot names the room from it, posts it as the room's first message and
  // starts on it, so nothing here depends on catching the invite in time.
  prompt: string | null = null,
): Promise<string> {
  // Subscribed before the send, not after: the bot can invite faster than the
  // send's own round trip returns, and an invite that lands first is missed.
  //
  // The snapshot is what makes "the invite" mean the new one. MyMembership
  // re-fires for invites that were already pending — an old un-accepted agent
  // room is enough — and taking the first event wholesale opened a stale room
  // while the freshly spawned one sat unaccepted in the list.
  const known = new Set(
    client.getRooms()
      .filter((r) => r.getMyMembership() === 'invite' || r.getMyMembership() === 'join')
      .map((r) => r.roomId),
  )
  known.add(hostRoomId)
  const invited = waitForInvite(client, known)
  try {
    await client.sendMessage(hostRoomId, {
      msgtype: 'm.text',
      body: spawnCommand(provider),
      ...(prompt ? { 'com.construct.spawn': { prompt } } : {}),
    } as never)
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
      if (known.has(room.roomId) || isHiddenRoom(room)) return
      // Another open Construct (the Mac while you spawn from the phone)
      // auto-accepts the invite, and if its join lands before this device
      // syncs, the server reports the room as joined outright — no invite ever
      // reaches us. Count a new agent room arriving joined as the spawn too.
      if (membership !== 'invite' && !(membership === 'join' && isAgentRoom(client, room.roomId))) return
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
