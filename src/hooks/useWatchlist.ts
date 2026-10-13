import { useCallback, useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import {
  WATCHLIST_ACTION_EVENT,
  WATCHLIST_STATE_EVENT,
  type ItemStatus,
  type WatchlistAction,
  type WatchlistItem,
} from '../components/views/WatchlistView'

// The service answers every action with an m.notice carrying this key.
const RESULT_KEY = 'com.construct.watchlist.result'
// A tap the service never answers (it is down) must not spin forever.
const PENDING_TIMEOUT_MS = 30_000

/**
 * The Watchlist room's list, from `com.construct.watchlist` room state, and a
 * way to act on it. Acting sends an event into the room for the service on the
 * Pi; the list updates when the service republishes the state, and the tapped
 * title shows the service's reply.
 */
export function useWatchlist(client: sdk.MatrixClient, roomId: string) {
  const [items, setItems] = useState<WatchlistItem[]>([])
  const [status, setStatus] = useState<Record<string, ItemStatus>>({})

  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return
    const read = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content = room.currentState.getStateEvents(WATCHLIST_STATE_EVENT as any, '')?.getContent()
      setItems(Array.isArray(content?.items) ? content.items : [])
    }
    read()
    const onState = (ev: sdk.MatrixEvent) => { if (ev.getType() === WATCHLIST_STATE_EVENT) read() }
    // Replies are matched by item id, not request id: a reply to a tap made on
    // another device is still news about that title.
    const onTimeline = (ev: sdk.MatrixEvent, r: sdk.Room | undefined) => {
      if (r?.roomId !== roomId) return
      const result = ev.getContent()?.[RESULT_KEY]
      if (!result?.id) return
      setStatus((s) => ({ ...s, [result.id]: { state: result.ok ? 'ok' : 'failed', action: result.action, message: result.message } }))
    }
    room.on(sdk.RoomStateEvent.Events, onState)
    room.on(sdk.RoomEvent.CurrentStateUpdated, read)
    client.on(sdk.RoomEvent.Timeline, onTimeline)
    return () => {
      room.off(sdk.RoomStateEvent.Events, onState)
      room.off(sdk.RoomEvent.CurrentStateUpdated, read)
      client.off(sdk.RoomEvent.Timeline, onTimeline)
    }
  }, [client, roomId])

  const act = useCallback(async (action: WatchlistAction, id: string) => {
    // The action rides along so a pending heart tap doesn't read as "Starting on the TV…".
    setStatus((s) => ({ ...s, [id]: { state: 'pending', action } }))
    setTimeout(() => setStatus((s) => (s[id]?.state === 'pending'
      ? { ...s, [id]: { state: 'failed', action, message: 'No answer from the watchlist service.' } }
      : s)), PENDING_TIMEOUT_MS)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.sendEvent(roomId, WATCHLIST_ACTION_EVENT as any, { action, id, request_id: crypto.randomUUID() } as any)
    } catch (err) {
      setStatus((s) => ({ ...s, [id]: { state: 'failed', action, message: `Couldn't send: ${(err as Error).message}` } }))
    }
  }, [client, roomId])

  return { items, status, act }
}
