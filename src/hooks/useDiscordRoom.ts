import { useCallback, useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import {
  DISCORD_ACTION_EVENT,
  DISCORD_STATE_EVENT,
  type DiscordAction,
  type DiscordState,
  type DiscordStatus,
} from '../components/views/DiscordView'

// The service answers every action with an m.notice carrying this key.
const RESULT_KEY = 'com.construct.discord.result'
// A tap the service never answers (it is down) must not spin forever.
const PENDING_TIMEOUT_MS = 30_000

const EMPTY: DiscordState = { needs: [], pending: [], seen: [], threads: [], syncedAt: null }

/**
 * The Discord room's lists, from `com.construct.discord` room state, and a way
 * to act on them. Acting sends an event into the room for the service on the
 * Pi; the lists update when the service republishes the state.
 */
export function useDiscordRoom(client: sdk.MatrixClient, roomId: string) {
  const [state, setState] = useState<DiscordState>(EMPTY)
  const [status, setStatus] = useState<Record<string, DiscordStatus>>({})

  // Listens on the client, not the room object: the page can open before the
  // room is joined or synced (right after accepting the invite), and a
  // room-level listener attached to nothing never fired again.
  useEffect(() => {
    let last: string | null = null
    const read = () => {
      const room = client.getRoom(roomId)
      if (!room) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = room.currentState.getStateEvents(DISCORD_STATE_EVENT as any, '')?.getContent()
      // Read on every sync; only a changed list re-renders.
      const key = JSON.stringify(c ?? null)
      if (key === last) return
      last = key
      setState({
        needs: Array.isArray(c?.needs) ? c.needs : [],
        pending: Array.isArray(c?.pending) ? c.pending : [],
        seen: Array.isArray(c?.seen) ? c.seen : [],
        threads: Array.isArray(c?.threads) ? c.threads : [],
        syncedAt: typeof c?.syncedAt === 'string' ? c.syncedAt : null,
      })
    }
    read()
    // Read on the next tick: RoomStateEvent.Events can fire before
    // currentState holds the new event.
    const onState = (ev: sdk.MatrixEvent) => {
      if (ev.getRoomId() === roomId && ev.getType() === DISCORD_STATE_EVENT) setTimeout(read, 0)
    }
    const onRoom = (r: sdk.Room) => { if (r.roomId === roomId) read() }
    const onTimeline = (ev: sdk.MatrixEvent, r: sdk.Room | undefined) => {
      if (r?.roomId !== roomId) return
      if (ev.getType() === DISCORD_STATE_EVENT) setTimeout(read, 0)
      const result = ev.getContent()?.[RESULT_KEY]
      if (!result?.id) return
      setStatus((s) => ({ ...s, [result.id]: { state: result.ok ? 'ok' : 'failed', action: result.action, message: result.message } }))
    }
    // After the app sleeps (backgrounded phone), sync catches up in one go;
    // reading again when the page is shown again covers anything missed.
    const onVisible = () => { if (document.visibilityState === 'visible') read() }
    client.on(sdk.RoomStateEvent.Events, onState)
    client.on(sdk.ClientEvent.Room, onRoom)
    client.on(sdk.RoomEvent.Timeline, onTimeline)
    client.on(sdk.ClientEvent.Sync, read)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      client.off(sdk.RoomStateEvent.Events, onState)
      client.off(sdk.ClientEvent.Room, onRoom)
      client.off(sdk.RoomEvent.Timeline, onTimeline)
      client.off(sdk.ClientEvent.Sync, read)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [client, roomId])

  // A failure shows as a banner on the page; it goes away on its own.
  useEffect(() => {
    if (!Object.values(status).some((s) => s.state === 'failed')) return
    const t = setTimeout(() => setStatus((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v.state !== 'failed'))), 8000)
    return () => clearTimeout(t)
  }, [status])

  const act = useCallback(async (action: DiscordAction, id: string) => {
    setStatus((s) => ({ ...s, [id]: { state: 'pending', action } }))
    setTimeout(() => setStatus((s) => (s[id]?.state === 'pending'
      ? { ...s, [id]: { state: 'failed', action, message: 'No answer from the Discord service.' } }
      : s)), PENDING_TIMEOUT_MS)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.sendEvent(roomId, DISCORD_ACTION_EVENT as any, { action, id, request_id: crypto.randomUUID() } as any)
    } catch (err) {
      setStatus((s) => ({ ...s, [id]: { state: 'failed', action, message: `Couldn't send: ${(err as Error).message}` } }))
    }
  }, [client, roomId])

  return { state, status, act }
}
