import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'

/**
 * Whether this agent room's bot is stuck waiting on the provider's quota.
 *
 * Unlike `useAgentActivity`, this is not inference: the bot publishes
 * `com.construct.agent_blocked` room state when a turn comes back "usage limit
 * reached" and clears it on the next turn that runs. Reading state rather than
 * scanning the timeline means the button appears exactly while the room is
 * stuck — scrolling back past an old block cannot resurrect it.
 */
export const AGENT_BLOCKED_EVENT = 'com.construct.agent_blocked'

export interface AgentBlocked {
  /** The provider's own wording, e.g. "You've hit your session limit · resets 1:10pm". */
  reason: string
  /** Epoch ms the quota window rolls over, when the bot could parse one. */
  resetsAt: number | null
  /**
   * Whether pressing Continue can plausibly work yet — the window has rolled
   * over, or the bot never parsed a time so there is nothing to wait for.
   * Flips on its own at `resetsAt`; the bar does not need a new state event.
   */
  canContinue: boolean
}

export function useAgentBlocked(client: sdk.MatrixClient, roomId: string): AgentBlocked | null {
  const [blocked, setBlocked] = useState<AgentBlocked | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) { setBlocked(null); return }
    const read = () => {
      const content = room.currentState
        .getStateEvents(AGENT_BLOCKED_EVENT as any, '')?.getContent() as any
      setBlocked(content?.blocked
        ? {
            reason: String(content.reason ?? 'Blocked'),
            resetsAt: content.resets_at ?? null,
            canContinue: false, // recomputed below against the clock
          }
        : null)
      setNow(Date.now())
    }
    read()
    const onState = (ev: sdk.MatrixEvent) => {
      if (ev.getRoomId() === roomId && ev.getType() === AGENT_BLOCKED_EVENT) read()
    }
    room.currentState.on(sdk.RoomStateEvent.Events, onState)
    return () => { room.currentState.off(sdk.RoomStateEvent.Events, onState) }
  }, [client, roomId])

  // One timer that fires at the reset itself, rather than a ticking interval:
  // nothing about the bar changes in between. A device asleep past the reset
  // wakes up with a stale `now`, so the timeout is re-armed from the current
  // clock on every render that changes `resetsAt`.
  const resetsAt = blocked?.resetsAt ?? null
  useEffect(() => {
    if (!resetsAt) return
    const wait = resetsAt - Date.now()
    if (wait <= 0) { setNow(Date.now()); return }
    // setTimeout saturates past ~24.8 days and would fire immediately.
    const t = setTimeout(() => setNow(Date.now()), Math.min(wait + 1000, 2 ** 31 - 1))
    return () => clearTimeout(t)
  }, [resetsAt, now])

  if (!blocked) return null
  return { ...blocked, canContinue: !blocked.resetsAt || now >= blocked.resetsAt }
}

/**
 * Drop the provider's own "· resets 1:10pm (Europe/Istanbul)" tail.
 *
 * That clock is written in whatever zone the provider chose to name, and it is
 * a wall time with no date — so it stays right on the screen long after the
 * window has rolled over. We re-render it from `resets_at` instead, in the
 * reader's zone; keeping both would show the same reset twice, disagreeing.
 */
export function blockedHeadline(reason: string): string {
  return reason.replace(/\s*[·|,-]?\s*resets?\b.*$/i, '').trim() || reason.trim()
}

/** "resets 1:10pm", or "" when the bot could not parse a time out of the notice. */
export function formatResetsAt(resetsAt: number | null): string {
  if (!resetsAt) return ''
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  // The quota window can roll over past midnight, and a bare "1:10am" then
  // reads as "ten minutes ago" rather than "in nine hours".
  const today = new Date()
  return at.toDateString() === today.toDateString() ? time : `${time} tomorrow`
}
