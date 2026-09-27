import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'
import { AGENT_BLOCKED_EVENT } from './useAgentBlocked'
import { roomAgentState, sameAgentState, type RoomAgentState } from '../lib/roomAgentState'

// Runs go stale on the clock, not on events, so re-derive everything this
// often even when the rooms are quiet.
const REFRESH_MS = 30_000

/**
 * RoomAgentState for every joined room, kept live from the client's own
 * events. Updates are coalesced to one pass per frame, so a burst of tool lines
 * costs one re-derive per room rather than one per event.
 */
export function useRoomAgentStates(
  clientReady: boolean,
  roomIds: string[],
  userId: string,
): Record<string, RoomAgentState> {
  const [states, setStates] = useState<Record<string, RoomAgentState>>({})
  // A stable key, so a new array with the same rooms doesn't resubscribe.
  const roomsKey = roomIds.join('\n')

  useEffect(() => {
    if (!clientReady) return
    let client: sdk.MatrixClient
    try { client = getClient() } catch { return }
    const wanted = new Set(roomsKey ? roomsKey.split('\n') : [])

    const dirty = new Set<string>()
    let frame: number | null = null

    const flush = () => {
      frame = null
      const now = Date.now()
      const ids = [...dirty]
      dirty.clear()
      setStates((prev) => {
        let next = prev
        for (const id of ids) {
          const room = client.getRoom(id)
          if (!room) continue
          const state = roomAgentState(room, userId, now)
          if (sameAgentState(prev[id], state)) continue
          if (next === prev) next = { ...prev }
          next[id] = state
        }
        return next
      })
    }
    const mark = (roomId: string | undefined) => {
      if (!roomId || !wanted.has(roomId)) return
      dirty.add(roomId)
      if (frame === null) frame = requestAnimationFrame(flush)
    }
    const markAll = () => { for (const id of wanted) mark(id) }

    const onTimeline = (_e: sdk.MatrixEvent, room: sdk.Room | undefined) => mark(room?.roomId)
    const onDecrypted = (e: sdk.MatrixEvent) => mark(e.getRoomId())
    const onTyping = (_e: sdk.MatrixEvent, member: sdk.RoomMember) => mark(member.roomId)
    const onState = (e: sdk.MatrixEvent) => {
      if (e.getType() === AGENT_BLOCKED_EVENT) mark(e.getRoomId())
    }
    const onVisible = () => { if (document.visibilityState === 'visible') markAll() }

    client.on(sdk.RoomEvent.Timeline, onTimeline)
    client.on(sdk.MatrixEventEvent.Decrypted, onDecrypted)
    client.on(sdk.RoomMemberEvent.Typing, onTyping)
    client.on(sdk.RoomStateEvent.Events, onState)
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(markAll, REFRESH_MS)
    markAll()

    return () => {
      client.off(sdk.RoomEvent.Timeline, onTimeline)
      client.off(sdk.MatrixEventEvent.Decrypted, onDecrypted)
      client.off(sdk.RoomMemberEvent.Typing, onTyping)
      client.off(sdk.RoomStateEvent.Events, onState)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [clientReady, roomsKey, userId])

  return states
}
