import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { AGENT_ROOM_TYPE } from '../lib/roomMeta'

/**
 * How much of the Claude and Codex plans is used, account-wide.
 *
 * The bot polls the quotas (only its host holds the logins) and publishes them
 * as `com.construct.plan_usage` room state in whichever agent room was last
 * active — state key '' for Claude, 'codex' for Codex. A quota is one number
 * for the whole account, so this reads the newest copy across every room
 * rather than caring which room it landed in.
 */
export const PLAN_USAGE_EVENT = 'com.construct.plan_usage'

export interface UsageWindow {
  percent: number
  /** Epoch ms the window rolls over, when the provider said. */
  resetsAt: number | null
}

export interface ExtraUsage {
  enabled: boolean
  /** Minor units — divide by 10^exponent for the amount. */
  used: number | null
  limit: number | null
  currency: string | null
  exponent: number
  disabledReason: string | null
}

export interface PlanUsage {
  session: UsageWindow | null
  weekly: UsageWindow | null
  /** Per-model weekly caps, only on plans that have them. */
  models: Record<string, UsageWindow>
  extra: ExtraUsage | null
  fetchedAt: number
}

function toWindow(raw: any): UsageWindow | null {
  if (!raw || !Number.isFinite(raw.percent)) return null
  return { percent: Math.max(0, Math.round(raw.percent)), resetsAt: typeof raw.resets_at === 'number' ? raw.resets_at : null }
}

// Readings published before these fields existed simply lack them.
function toUsage(content: any): PlanUsage {
  const models: Record<string, UsageWindow> = {}
  for (const [name, raw] of Object.entries(content.models ?? {})) {
    const w = toWindow(raw)
    if (w) models[name] = w
  }
  const x = content.extra
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const extra = x ? {
    enabled: !!x.enabled,
    used: num(x.used),
    limit: num(x.limit),
    currency: typeof x.currency === 'string' ? x.currency : null,
    exponent: num(x.exponent) ?? 2,
    disabledReason: typeof x.disabled_reason === 'string' ? x.disabled_reason : null,
  } : null
  return {
    session: toWindow(content.session),
    weekly: toWindow(content.weekly),
    models,
    extra,
    fetchedAt: content.fetched_at,
  }
}

// Clock skew between the Pi and this device, not a licence to post-date.
const FUTURE_SLACK_MS = 5 * 60 * 1000

export interface CodexWindow extends UsageWindow {
  /** Window length, e.g. 300 for 5 hours or 10080 for a week. */
  minutes: number | null
}

export interface CodexUsage {
  /** Shortest window first — the one that stops work soonest. */
  windows: CodexWindow[]
  plan: string | null
  /** Free full resets OpenAI has granted and not yet used. */
  resetCredits: number
  fetchedAt: number
}

function toCodexUsage(content: any): CodexUsage | null {
  const windows = (Array.isArray(content.windows) ? content.windows : [])
    .map((raw: any) => {
      const w = toWindow(raw)
      return w && { ...w, minutes: Number.isFinite(raw.minutes) ? raw.minutes : null }
    })
    .filter(Boolean) as CodexWindow[]
  if (!windows.length) return null
  return {
    windows,
    plan: typeof content.plan === 'string' ? content.plan : null,
    resetCredits: Number.isFinite(content.reset_credits) ? content.reset_credits : 0,
    fetchedAt: content.fetched_at,
  }
}

/** Newest trusted reading under `stateKey` across every room: '' is Claude, 'codex' is Codex. */
function readNewest<T>(client: sdk.MatrixClient, stateKey: string, parse: (content: any) => T | null): T | null {
  let newest: any = null
  for (const room of client.getRooms()) {
    // Only the bot's own copy counts: it must sit in an agent room and be sent
    // by whoever created that room, which for agent rooms is the bot. Anyone
    // else able to send state could otherwise pin a fake reading here.
    const create = room.currentState.getStateEvents('m.room.create', '')
    if (create?.getContent()?.type !== AGENT_ROOM_TYPE) continue
    const ev = room.currentState.getStateEvents(PLAN_USAGE_EVENT as any, stateKey)
    if (!ev || ev.getSender() !== create.getSender()) continue
    const content = ev.getContent() as any
    if (typeof content?.fetched_at !== 'number') continue
    // A reading "from the future" would outrank every honest one forever.
    if (content.fetched_at > Date.now() + FUTURE_SLACK_MS) continue
    if (newest && newest.fetched_at >= content.fetched_at) continue
    newest = content
  }
  return newest ? parse(newest) : null
}

// The bot republishes at least every 30 minutes; past an hour of silence the
// numbers are the poller's last word, not the plan's current state.
export const STALE_MS = 60 * 60 * 1000

export function usageLevel(percent: number): string {
  if (percent >= 90) return 'critical'
  if (percent >= 75) return 'warn'
  return 'ok'
}

export function resetLabel(resetsAt: number | null, now: number): string {
  if (!resetsAt) return ''
  const ms = resetsAt - now
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Once a window has rolled over, the stored percent belongs to the old one. */
export function currentPercent(window: UsageWindow, now: number): number {
  return window.resetsAt !== null && window.resetsAt <= now ? 0 : window.percent
}

/** A clock that ticks once a minute, so countdowns stay true between publishes. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

export function usePlanUsage(client: sdk.MatrixClient | null): PlanUsage | null {
  return usePublishedUsage(client, '', toUsage)
}

export function useCodexUsage(client: sdk.MatrixClient | null): CodexUsage | null {
  return usePublishedUsage(client, 'codex', toCodexUsage)
}

function usePublishedUsage<T>(
  client: sdk.MatrixClient | null,
  stateKey: string,
  parse: (content: any) => T | null,
): T | null {
  const [usage, setUsage] = useState<T | null>(() => (client ? readNewest(client, stateKey, parse) : null))

  useEffect(() => {
    if (!client) return
    const read = () => setUsage(readNewest(client, stateKey, parse))
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
  // `parse` is always a module-level function, so it never changes identity.
  }, [client, stateKey, parse])

  return usage
}
