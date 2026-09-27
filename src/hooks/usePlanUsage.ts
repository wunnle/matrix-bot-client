import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { AGENT_ROOM_TYPE } from '../lib/roomMeta'

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
  if (!raw || !Number.isFinite(raw.percent)) return null
  return { percent: Math.max(0, Math.round(raw.percent)),resetsAt: typeof raw.resets_at === 'number' ? raw.resets_at : null }
}

// Clock skew between the Pi and this device, not a licence to post-date.
const FUTURE_SLACK_MS = 5 * 60 * 1000

function readNewest(client: sdk.MatrixClient): PlanUsage | null {
  let newest: PlanUsage | null = null
  for (const room of client.getRooms()) {
    // Only the bot's own copy counts: it must sit in an agent room and be sent
    // by whoever created that room, which for agent rooms is the bot. Anyone
    // else able to send state could otherwise pin a fake reading here.
    const create = room.currentState.getStateEvents('m.room.create', '')
    if (create?.getContent()?.type !== AGENT_ROOM_TYPE) continue
    const ev = room.currentState.getStateEvents(PLAN_USAGE_EVENT as any, '')
    if (!ev || ev.getSender() !== create.getSender()) continue
    const content = ev.getContent() as any
    if (typeof content?.fetched_at !== 'number') continue
    // A reading "from the future" would outrank every honest one forever.
    if (content.fetched_at > Date.now() + FUTURE_SLACK_MS) continue
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
