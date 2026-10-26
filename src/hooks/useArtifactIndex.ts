import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import * as sdk from 'matrix-js-sdk'
import { ARTIFACT_INDEX_EVENT, artifactIdOf, parseArtifact, parseArtifactIndex, type ArtifactIndexEntry } from '../lib/artifact'
import type { RoomArtifact } from '../lib/roomMedia'

// Cards already fetched, by event and index version, so reopening the panel
// doesn't fetch them again; a republish bumps updatedAt and refetches.
const cache = new Map<string, RoomArtifact | null>()
const cacheKey = (e: ArtifactIndexEntry) => `${e.eventId}@${e.updatedAt}`

// One card as it stands now: the event, overlaid with its newest edit.
// Decrypted in an encrypted room, where the copy's key lives in the content.
async function loadCard(client: sdk.MatrixClient, roomId: string, entry: ArtifactIndexEntry): Promise<RoomArtifact | null> {
  const map = client.getEventMapper()
  const event = map(await client.fetchRoomEvent(roomId, entry.eventId))
  await client.decryptEventIfNeeded(event)
  let content: Record<string, unknown> = event.getContent()
  try {
    const edits = await client.fetchRelations(roomId, entry.eventId, sdk.RelationType.Replace, null, {
      dir: sdk.Direction.Backward, limit: 1,
    })
    if (edits.chunk[0]) {
      const edit = map(edits.chunk[0])
      await client.decryptEventIfNeeded(edit)
      const replaced = edit.getContent()['m.new_content']
      if (replaced && typeof replaced === 'object') content = replaced as Record<string, unknown>
    }
  } catch { /* no edits, or none readable: the original card still says something */ }
  const artifact = parseArtifact(content['com.construct.artifact'])
  if (!artifact) return null
  return {
    ...artifact,
    id: artifactIdOf(artifact.url) ?? entry.id,
    eventId: entry.eventId,
    timestamp: entry.updatedAt || event.getTs(),
  }
}

/**
 * The room's artifacts that aren't in the loaded messages, found through the
 * bot's index (room state, always loaded) and fetched one card at a time.
 * `loaded` is the ids the timeline already accounts for. Only while `enabled`
 * (the panel is open): nothing is fetched for a panel nobody is looking at.
 */
export function useArtifactIndex(client: sdk.MatrixClient, roomId: string, enabled: boolean, loaded: string[]): RoomArtifact[] {
  // Bumped when fetched cards land in the cache.
  const [fetched, setFetched] = useState(0)
  const indexEvent = useIndexEvent(client, roomId)

  const loadedKey = loaded.join(' ')
  const missing = useMemo(() => {
    if (!enabled) return []
    const have = new Set(loadedKey.split(' '))
    return parseArtifactIndex(indexEvent?.getContent()).filter((e) => !have.has(e.id))
  }, [enabled, indexEvent, loadedKey])

  // Fetch what isn't cached; a re-render picks the results up from the cache.
  useEffect(() => {
    const todo = missing.filter((e) => !cache.has(cacheKey(e)))
    if (!todo.length) return
    let live = true
    Promise.all(todo.map(async (e) => {
      try { cache.set(cacheKey(e), await loadCard(client, roomId, e)) } catch { /* try again next time */ }
    })).then(() => { if (live) setFetched((n) => n + 1) })
    return () => { live = false }
  }, [client, roomId, missing])

  return useMemo(
    () => missing.flatMap((e) => {
      const card = cache.get(cacheKey(e))
      return card ? [card] : []
    }),
    // `fetched` is the cache's version: new cards are read when it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [missing, fetched],
  )
}

// The index event, kept current: the SDK hands back the same event object
// until the bot replaces it, which is what tells React it changed.
function useIndexEvent(client: sdk.MatrixClient, roomId: string): sdk.MatrixEvent | null {
  const subscribe = useCallback((onChange: () => void) => {
    const onState = (event: sdk.MatrixEvent) => {
      if (event.getRoomId() === roomId && event.getType() === ARTIFACT_INDEX_EVENT) onChange()
    }
    client.on(sdk.RoomStateEvent.Events, onState)
    return () => { client.off(sdk.RoomStateEvent.Events, onState) }
  }, [client, roomId])
  return useSyncExternalStore(
    subscribe,
    () => client.getRoom(roomId)?.currentState.getStateEvents(ARTIFACT_INDEX_EVENT, '') ?? null,
  )
}

/** When an artifact in the room was last published or republished, by the
 * index; 0 when it has none. Read with the panel closed, for the header's dot. */
export function useArtifactsUpdatedAt(client: sdk.MatrixClient, roomId: string): number {
  const indexEvent = useIndexEvent(client, roomId)
  return useMemo(
    () => parseArtifactIndex(indexEvent?.getContent()).reduce((max, e) => Math.max(max, e.updatedAt), 0),
    [indexEvent],
  )
}
