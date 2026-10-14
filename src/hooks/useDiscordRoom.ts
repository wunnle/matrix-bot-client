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

const EMPTY: DiscordState = { needs: [], pending: [], seen: [], syncedAt: null }

/**
 * The Discord room's lists, from `com.construct.discord` room state, and a way
 * to act on them. Acting sends an event into the room for the service on the
 * Pi; the lists update when the service republishes the state.
 */
export function useDiscordRoom(client: sdk.MatrixClient, roomId: string) {
  const [state, setState] = useState<DiscordState>(EMPTY)
  const [status, setStatus] = useState<Record<string, DiscordStatus>>({})

  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return
    const read = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = room.currentState.getStateEvents(DISCORD_STATE_EVENT as any, '')?.getContent()
      setState({
        needs: Array.isArray(c?.needs) ? c.needs : [],
        pending: Array.isArray(c?.pending) ? c.pending : [],
        seen: Array.isArray(c?.seen) ? c.seen : [],
        syncedAt: typeof c?.syncedAt === 'string' ? c.syncedAt : null,
      })
    }
    read()
    const onState = (ev: sdk.MatrixEvent) => { if (ev.getType() === DISCORD_STATE_EVENT) read() }
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
