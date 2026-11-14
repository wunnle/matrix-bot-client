import { useCallback, useMemo, useSyncExternalStore } from 'react'
import * as sdk from 'matrix-js-sdk'
import { ROOM_STATUS_EVENT, issuesInName, parseRoomStatus, type RoomStatus } from '../lib/roomStatus'

export interface RoomStatusView {
  /** The bot's status, or null when it has never published one (Hermes rooms, older bots). */
  status: RoomStatus | null
  /** The issues the room is about: the agent's own word, else the ids in the room name. */
  issues: string[]
  /** Where `issues` came from. */
  issuesFrom: 'agent' | 'name' | null
}

/** The room's status, kept current as the bot rewrites it and the room is renamed. */
export function useRoomStatus(client: sdk.MatrixClient, roomId: string): RoomStatusView {
  const subscribe = useCallback((onChange: () => void) => {
    const onState = (event: sdk.MatrixEvent) => {
      if (event.getRoomId() === roomId && event.getType() === ROOM_STATUS_EVENT) onChange()
    }
    const onName = (room: sdk.Room) => { if (room.roomId === roomId) onChange() }
    // On the client, not on room.currentState: a limited sync swaps that
    // object out, and a listener on the old one hears nothing (see useAgentBlocked).
    client.on(sdk.RoomStateEvent.Events, onState)
    client.on(sdk.RoomEvent.Name, onName)
    return () => {
      client.off(sdk.RoomStateEvent.Events, onState)
      client.off(sdk.RoomEvent.Name, onName)
    }
  }, [client, roomId])

  const event = useSyncExternalStore(
    subscribe,
    () => client.getRoom(roomId)?.currentState.getStateEvents(ROOM_STATUS_EVENT, '') ?? null,
  )
  const name = useSyncExternalStore(subscribe, () => client.getRoom(roomId)?.name)

  return useMemo(() => {
    const status = event ? parseRoomStatus(event.getContent(), event.getTs()) : null
    if (status?.issues.length) return { status, issues: status.issues, issuesFrom: 'agent' as const }
    const fromName = issuesInName(name)
    return { status, issues: fromName, issuesFrom: fromName.length ? ('name' as const) : null }
  }, [event, name])
}
