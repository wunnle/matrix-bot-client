import * as sdk from 'matrix-js-sdk'
import { getClient } from './matrix'

function getPinnedIds(room: sdk.Room): string[] {
  const st = room.currentState.getStateEvents(sdk.EventType.RoomPinnedEvents, '')
  const content = st?.getContent() as { pinned?: string[] } | undefined
  return content?.pinned?.filter((id): id is string => typeof id === 'string') ?? []
}

/**
 * Set Matrix room `m.room.pinned_events` state (not local storage).
 * New pins are appended so they appear first in this app’s pinned strip
 * (see ChatView `refreshPinned` + `[...ids].reverse()`).
 */
export async function setRoomPinnedEventIds(
  roomId: string,
  nextPinned: string[],
): Promise<void> {
  const client = getClient()
  const content = { pinned: nextPinned }
  await client.sendStateEvent(roomId, sdk.EventType.RoomPinnedEvents, content, '')
}

export async function pinRoomEvent(roomId: string, eventId: string): Promise<void> {
  const client = getClient()
  const room = client.getRoom(roomId)
  if (!room) throw new Error('Room not found')
  const ids = getPinnedIds(room)
  if (ids.includes(eventId)) return
  const next = [...ids.filter((id) => id !== eventId), eventId]
  await setRoomPinnedEventIds(roomId, next)
}

export async function unpinRoomEvent(roomId: string, eventId: string): Promise<void> {
  const client = getClient()
  const room = client.getRoom(roomId)
  if (!room) throw new Error('Room not found')
  const next = getPinnedIds(room).filter((id) => id !== eventId)
  await setRoomPinnedEventIds(roomId, next)
}
