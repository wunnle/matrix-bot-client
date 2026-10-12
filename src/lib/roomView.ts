// Rooms with pages. A room opts in with one state event naming its view kind;
// Construct draws that kind from the room's own state, and the view acts by
// sending events into the room for the service that owns it. Construct holds
// no logic of its own here — only how to draw each kind.
//
//   declare  `com.construct.room_view` = {kind}
//   read     the kind's own state event (e.g. `com.construct.watchlist`)
//   act      custom room events, answered by the owning service
import type { Room } from 'matrix-js-sdk'

export const ROOM_VIEW_EVENT = 'com.construct.room_view'

/** The kinds this build knows how to draw. An unknown kind falls back to chat. */
export const ROOM_VIEW_KINDS = ['watchlist'] as const
export type RoomViewKind = typeof ROOM_VIEW_KINDS[number]

export function roomViewKind(room: Room | null | undefined): RoomViewKind | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kind = room?.currentState.getStateEvents(ROOM_VIEW_EVENT as any, '')?.getContent()?.kind
  return (ROOM_VIEW_KINDS as readonly string[]).includes(kind) ? kind as RoomViewKind : null
}
