import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Message } from '../types'

/**
 * What the room's bot appears to be doing right now, derived from what is
 * already on the wire: the user's last message, the bot's typing flag, and its
 * `com.construct.tool_progress` events. Nothing new is sent or requested.
 *
 * This is inference, not a protocol — the gateway never says "I am working".
 * So it is bounded on both ends: a run is only considered live between the
 * user's last message and the bot's next real reply, and it expires after
 * STALE_MS regardless, so a run that dies mid-flight can't pin a spinner to the
 * screen forever. (Same reasoning, and same duration, as the adapter's mute TTL.)
 */
export interface AgentActivity {
  /** 'thinking' = no tool yet; 'working' = a tool line has come in. */
  phase: 'thinking' | 'working'
  /** Verb shown to the user, e.g. "Searching". */
  label: string
  /** What it's acting on, when the tool line carried it. */
  detail?: string
  /** Timestamp the run is measured from — the user's message. */
  startedAt: number
  /** Whole seconds since startedAt, ticking while the row is visible. */
  elapsedSec: number
}

// A run nobody ever ended stops being believable after this long.
const STALE_MS = 5 * 60 * 1000

// No tool progress and no typing flag for this long means the run most likely
// never started (or ended without a reply we can see).
const SILENT_GRACE_MS = 90 * 1000

/** Tool name → the verb a person would use for it. */
function labelForTool(tool: string): string {
  switch (tool.toLowerCase()) {
    case 'bash':
    case 'terminal':
    case 'shell':
      return 'Running'
    case 'read':
    case 'grep':
    case 'glob':
    case 'search':
    case 'ls':
      return 'Searching'
    case 'edit':
    case 'write':
    case 'patch':
    case 'notebookedit':
      return 'Editing'
    case 'webfetch':
    case 'websearch':
    case 'fetch':
      return 'Fetching'
    case 'task':
    case 'agent':
      return 'Delegating'
    default:
      return 'Working'
  }
}

/**
 * The wall clock as an external store, ticking in whole seconds: one shared
 * timer for every subscriber, and none at all while the tab is hidden (a
 * backgrounded PWA has nothing to redraw, and iOS throttles it anyway).
 */
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null

function emitClock() {
  for (const l of clockListeners) l()
}

function syncClockTimer() {
  const wanted = clockListeners.size > 0 && document.visibilityState === 'visible'
  if (wanted && clockTimer === null) {
    clockTimer = setInterval(emitClock, 1000)
  } else if (!wanted && clockTimer !== null) {
    clearInterval(clockTimer)
    clockTimer = null
  }
}

function subscribeToClock(onChange: () => void): () => void {
  clockListeners.add(onChange)
  if (clockListeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  syncClockTimer()
  return () => {
    clockListeners.delete(onChange)
    if (clockListeners.size === 0) {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    syncClockTimer()
  }
}

function onVisibilityChange() {
  syncClockTimer()
  // Coming back from the background, the displayed elapsed time is stale by
  // however long we were away — repaint before the next tick.
  if (document.visibilityState === 'visible') emitClock()
}

function getClockSnapshot(): number {
  return Math.floor(Date.now() / 1000)
}

// A constant snapshot and a no-op unsubscribe: React sees a store that never
// changes, so an idle room never re-renders on the clock. The value is never
// read — the hook returns null before touching it when there is no run.
const NO_UNSUBSCRIBE = () => {}
function getIdleSnapshot(): number {
  return 0
}

function isBotMessage(m: Message): boolean {
  return !m.isOwnMessage && !m.isPeerMessage
}

/**
 * @param messages full room timeline, oldest first
 * @param botTyping whether the room's bot currently has a typing flag set
 */
export function useAgentActivity(messages: Message[], botTyping: boolean): AgentActivity | null {
  // Everything below is a function of "the run that started at the user's last
  // message", so find that anchor once.
  const base = useMemo(() => {
    let anchor = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isOwnMessage) { anchor = i; break }
    }
    if (anchor === -1) return null

    let lastTool: Message | null = null
    for (let i = anchor + 1; i < messages.length; i++) {
      const m = messages[i]
      if (!isBotMessage(m)) continue
      // A plain reply from the bot ends the run; tool lines keep it alive.
      if (m.toolProgress?.length) lastTool = m
      else return null
    }

    const startedAt = messages[anchor].timestamp
    const line = lastTool?.toolProgress?.[lastTool.toolProgress.length - 1]
    return {
      phase: (line ? 'working' : 'thinking') as AgentActivity['phase'],
      label: line ? labelForTool(line.tool) : 'Thinking',
      detail: line?.content,
      startedAt,
      // The freshest evidence the run is alive, for the silence check below.
      lastSignalAt: lastTool?.timestamp ?? startedAt,
    }
  }, [messages])

  // The wall clock is an external store, so subscribe to it rather than
  // mirroring it into state: the snapshot is whole seconds (stable between
  // ticks, so React can bail out) and is read fresh on the first frame after a
  // run starts, not a second late.
  //
  // Only subscribe while there is a run to tick for. Subscribing unconditionally
  // re-rendered the entire timeline once a second in an idle room, for a number
  // nothing was displaying — which, among other things, rebuilt code blocks
  // under any in-progress scrollbar drag.
  const live = base !== null
  const subscribe = useCallback(
    (onChange: () => void) => (live ? subscribeToClock(onChange) : NO_UNSUBSCRIBE),
    [live],
  )
  const nowSec = useSyncExternalStore(subscribe, live ? getClockSnapshot : getIdleSnapshot)

  if (!base) return null
  const now = nowSec * 1000
  if (now - base.startedAt > STALE_MS) return null
  if (!botTyping && base.phase === 'thinking' && now - base.lastSignalAt > SILENT_GRACE_MS) return null

  return {
    phase: base.phase,
    label: base.label,
    detail: base.detail,
    startedAt: base.startedAt,
    elapsedSec: Math.max(0, Math.floor((now - base.startedAt) / 1000)),
  }
}

/** "42s", "3m 07s" — short enough to sit next to the label. */
export function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}
