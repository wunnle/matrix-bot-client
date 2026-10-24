import { useCallback, useMemo, useSyncExternalStore } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { RoomRef } from '../lib/roomMedia'

/**
 * The Linear issues a room has talked about, from the bot's index in room
 * state (scripts/linear-index.mjs): keys and the message that last named each,
 * nothing more. Fills in the issues mentioned before the loaded messages.
 */
export const LINEAR_INDEX_EVENT = 'com.construct.linear'
const LINEAR_WORKSPACE = 'wunnle'

interface Entry { key: string; eventId: string; at: number }

function parse(content: unknown): Entry[] {
  const list = (content as { issues?: unknown } | null)?.issues
  if (!Array.isArray(list)) return []
  return list.flatMap((raw) => {
    const e = raw as Record<string, unknown> | null
    if (!e || typeof e.key !== 'string' || !/^[A-Z][A-Z0-9]*-\d+$/.test(e.key)) return []
    if (typeof e.eventId !== 'string' || !e.eventId.startsWith('$')) return []
    return [{ key: e.key, eventId: e.eventId, at: typeof e.at === 'number' ? e.at : 0 }]
  })
}

/** Indexed issues not among `loaded` (the keys the timeline already has), newest first. */
export function useLinearIndex(client: sdk.MatrixClient, roomId: string, enabled: boolean, loaded: string[]): RoomRef[] {
  const subscribe = useCallback((onChange: () => void) => {
    const onState = (event: sdk.MatrixEvent) => {
      if (event.getRoomId() === roomId && event.getType() === LINEAR_INDEX_EVENT) onChange()
    }
    client.on(sdk.RoomStateEvent.Events, onState)
    return () => { client.off(sdk.RoomStateEvent.Events, onState) }
  }, [client, roomId])
  const indexEvent = useSyncExternalStore(
    subscribe,
    () => client.getRoom(roomId)?.currentState.getStateEvents(LINEAR_INDEX_EVENT, '') ?? null,
  )

  const loadedKey = loaded.join(' ')
  return useMemo(() => {
    if (!enabled) return []
    const have = new Set(loadedKey.split(' '))
    return parse(indexEvent?.getContent())
      .filter((e) => !have.has(e.key))
      .map((e) => ({
        kind: 'linear' as const,
        label: e.key,
        url: `https://linear.app/${LINEAR_WORKSPACE}/issue/${e.key}`,
        eventId: e.eventId,
        timestamp: e.at,
      }))
  }, [enabled, indexEvent, loadedKey])
}
