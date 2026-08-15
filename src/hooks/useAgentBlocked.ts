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

/** "resets 1:10pm", or "" when the bot could not parse a time out of the notice. */
export function formatResetsAt(resetsAt: number | null): string {
  if (!resetsAt) return ''
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
