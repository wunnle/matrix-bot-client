import { useCallback, useEffect, useRef, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { Message } from '../types'
import { eventToMessage, getMaxReadTs } from '../lib/eventToMessage'

/** A room's pinned events (m.room.pinned_events), resolved to messages. The
 *  refs are for callers outside React's flow: the timeline listener re-resolves
 *  when a pinned event decrypts, and pin toggles refresh after the write. */
export function usePinnedMessages(client: sdk.MatrixClient, roomId: string, userId: string, messageCount: number) {
  const [pinnedEventIds, setPinnedEventIds] = useState<string[]>([])
  const [pinnedDisplay, setPinnedDisplay] = useState<Message[]>([])
  const refreshPinnedRef = useRef<() => void>(() => {})
  const pinnedIdsRef = useRef<Set<string>>(new Set())
  const activeRoomIdRef = useRef(roomId)

  useEffect(() => {
    activeRoomIdRef.current = roomId
  }, [roomId])

  const refreshPinned = useCallback(async () => {
    const forRoom = roomId
    const room = client.getRoom(forRoom)
    if (!room) return
    const st = room.currentState.getStateEvents(sdk.EventType.RoomPinnedEvents, '')
    const content = st?.getContent() as { pinned?: string[] } | undefined
    const ids = content?.pinned ?? []
    pinnedIdsRef.current = new Set(ids)
    if (forRoom !== activeRoomIdRef.current) return
    setPinnedEventIds(ids)

    if (ids.length === 0) {
      setPinnedDisplay([])
      return
    }

    // Prefer the local timeline, then GET /rooms/.../event/... for each pin. That works when
    // timelineSupport was off, for thread based pins (getEventTimeline bails on thread roots), etc.
    const eventById = new Map<string, sdk.MatrixEvent>()
    for (const id of ids) {
      const local = room.findEventById(id)
      if (local) eventById.set(id, local)
    }
    const needFetch = ids.filter((id) => !eventById.has(id))
    if (needFetch.length > 0) {
      const mapper = client.getEventMapper()
      await Promise.all(
        needFetch.map(async (id) => {
          try {
            const raw = await client.fetchRoomEvent(forRoom, id)
            const ev = mapper(raw)
            await client.decryptEventIfNeeded(ev)
            eventById.set(id, ev)
          } catch {
            // 404, access denied, etc.
          }
        }),
      )
    }

    if (forRoom !== activeRoomIdRef.current) return

    const maxReadTs = getMaxReadTs(room, userId)
    const resolved: Message[] = []
    for (const id of [...ids].reverse()) {
      const ev = eventById.get(id)
      if (!ev || ev.isRedacted()) continue
      const t = ev.getType()
      if (t !== 'm.room.message' && t !== 'm.room.encrypted' && !ev.isDecryptionFailure()) continue
      resolved.push(eventToMessage(ev, userId, maxReadTs, room))
    }
    setPinnedDisplay(resolved)
  }, [client, roomId, userId])

  useEffect(() => {
    refreshPinnedRef.current = () => {
      void refreshPinned()
    }
  }, [refreshPinned])

  // Pinned events (m.room.pinned_events) — resolve when state changes or the timeline may contain them
  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return
    refreshPinned()
    const onState = (ev: sdk.MatrixEvent) => {
      if (ev.getType() === sdk.EventType.RoomPinnedEvents) refreshPinned()
    }
    const onSwap = () => refreshPinned()
    room.on(sdk.RoomStateEvent.Events, onState)
    room.on(sdk.RoomEvent.CurrentStateUpdated, onSwap)
    return () => {
      room.off(sdk.RoomStateEvent.Events, onState)
      room.off(sdk.RoomEvent.CurrentStateUpdated, onSwap)
    }
  }, [roomId, client, refreshPinned])

  useEffect(() => {
    if (pinnedEventIds.length === 0) return
    refreshPinned()
  }, [messageCount, pinnedEventIds.length, refreshPinned])

  return { pinnedEventIds, pinnedDisplay, pinnedIdsRef, refreshPinnedRef }
}
