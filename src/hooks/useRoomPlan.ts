import { useEffect, useState } from 'react'
import type * as sdk from 'matrix-js-sdk'
import { PLAN_EVENT, parsePlanSteps, type PlanStep } from '../lib/roomStatus'

// Plans already read, by event id. Each change is a new event, so an id's
// steps never change and the cache never goes stale.
const cache = new Map<string, PlanStep[]>()

async function loadPlan(client: sdk.MatrixClient, roomId: string, eventId: string): Promise<PlanStep[]> {
  // Usually just arrived, so already in the live timeline (and decrypted, or
  // on its way); otherwise fetched, like a pinned message.
  let event = client.getRoom(roomId)?.findEventById(eventId)
  if (!event) event = client.getEventMapper()(await client.fetchRoomEvent(roomId, eventId))
  await client.decryptEventIfNeeded(event)
  if (event.getType() !== PLAN_EVENT) return []
  return parsePlanSteps(event.getContent())
}

/** The steps of the plan the room status points at; null while there is none
 *  or it is still loading. */
export function useRoomPlan(client: sdk.MatrixClient, roomId: string, eventId: string | null): PlanStep[] | null {
  const [loaded, setLoaded] = useState<{ id: string; steps: PlanStep[] } | null>(null)

  useEffect(() => {
    if (!eventId || cache.has(eventId)) return
    let live = true
    loadPlan(client, roomId, eventId)
      .then((steps) => {
        cache.set(eventId, steps)
        if (live) setLoaded({ id: eventId, steps })
      })
      .catch(() => { /* unreadable: the panel just shows no plan */ })
    return () => { live = false }
  }, [client, roomId, eventId])

  if (!eventId) return null
  const steps = cache.get(eventId) ?? (loaded?.id === eventId ? loaded.steps : null)
  return steps?.length ? steps : null
}
