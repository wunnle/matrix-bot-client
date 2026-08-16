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
}

export function useAgentBlocked(client: sdk.MatrixClient, roomId: string): AgentBlocked | null {
  const [blocked, setBlocked] = useState<AgentBlocked | null>(null)

  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) { setBlocked(null); return }
    const read = () => {
      const content = room.currentState
        .getStateEvents(AGENT_BLOCKED_EVENT as any, '')?.getContent() as any
      setBlocked(content?.blocked
        ? { reason: String(content.reason ?? 'Blocked'), resetsAt: content.resets_at ?? null }
        : null)
    }
    read()
    const onState = (ev: sdk.MatrixEvent) => {
      if (ev.getRoomId() === roomId && ev.getType() === AGENT_BLOCKED_EVENT) read()
    }
    room.currentState.on(sdk.RoomStateEvent.Events, onState)
    return () => { room.currentState.off(sdk.RoomStateEvent.Events, onState) }
  }, [client, roomId])

  return blocked
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
