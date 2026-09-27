import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'

/**
 * How much of the Claude plan is used, account-wide.
 *
 * The bot polls the quota (only its host holds the login) and publishes it as
 * `com.construct.plan_usage` room state in whichever agent room was last
 * active. The quota is one number for the whole account, so this reads the
 * newest copy across every room rather than caring which room it landed in.
 */
export const PLAN_USAGE_EVENT = 'com.construct.plan_usage'

export interface UsageWindow {
  percent: number
  /** Epoch ms the window rolls over, when the provider said. */
  resetsAt: number | null
}

export interface PlanUsage {
  session: UsageWindow | null
  weekly: UsageWindow | null
  fetchedAt: number
}

function toWindow(raw: any): UsageWindow | null {
  if (!raw || typeof raw.percent !== 'number') return null
  return { percent: raw.percent, resetsAt: typeof raw.resets_at === 'number' ? raw.resets_at : null }
}

function readNewest(client: sdk.MatrixClient): PlanUsage | null {
  let newest: PlanUsage | null = null
  for (const room of client.getRooms()) {
    const content = room.currentState.getStateEvents(PLAN_USAGE_EVENT as any, '')?.getContent() as any
    if (typeof content?.fetched_at !== 'number') continue
    if (newest && newest.fetchedAt >= content.fetched_at) continue
    newest = { session: toWindow(content.session), weekly: toWindow(content.weekly), fetchedAt: content.fetched_at }
  }
  return newest
}

export function usePlanUsage(client: sdk.MatrixClient | null): PlanUsage | null {
  const [usage, setUsage] = useState<PlanUsage | null>(() => (client ? readNewest(client) : null))

  useEffect(() => {
    if (!client) return
    const read = () => setUsage(readNewest(client))
    read()
    const onState = (ev: sdk.MatrixEvent) => { if (ev.getType() === PLAN_USAGE_EVENT) read() }
    // Rooms arriving in a later sync bring their state with them, but not as
    // a state event this listener would see — so a finished sync re-reads too.
    const onSync = (state: sdk.SyncState) => { if (state === sdk.SyncState.Prepared) read() }
    client.on(sdk.RoomStateEvent.Events, onState)
    client.on(sdk.ClientEvent.Sync, onSync)
    return () => {
      client.off(sdk.RoomStateEvent.Events, onState)
      client.off(sdk.ClientEvent.Sync, onSync)
    }
  }, [client])

  return usage
}
