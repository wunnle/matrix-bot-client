import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { ROOM_VIEW_EVENT, roomViewKind, type RoomViewKind } from '../lib/roomView'

/** The room's page kind, kept current as its state changes. Null for a plain room. */
export function useRoomViewKind(client: sdk.MatrixClient, roomId: string): RoomViewKind | null {
  const [kind, setKind] = useState(() => roomViewKind(client.getRoom(roomId)))
  useEffect(() => {
    const room = client.getRoom(roomId)
    const read = () => setKind(roomViewKind(room))
    read()
    if (!room) return
    const onState = (ev: sdk.MatrixEvent) => { if (ev.getType() === ROOM_VIEW_EVENT) read() }
    room.on(sdk.RoomStateEvent.Events, onState)
    room.on(sdk.RoomEvent.CurrentStateUpdated, read)
    return () => {
      room.off(sdk.RoomStateEvent.Events, onState)
      room.off(sdk.RoomEvent.CurrentStateUpdated, read)
    }
  }, [client, roomId])
  return kind
}
