import { useEffect } from 'react'
import { agentActivityAt, formatElapsed, useClockSeconds } from '../hooks/useAgentActivity'
import type { AgentRun } from '../hooks/useAgentActivity'

interface Props {
  run: AgentRun | null
  botTyping: boolean
  /** Told only when liveness flips, so the room re-renders on transitions
   *  rather than on every tick. */
  onLiveChange: (live: boolean) => void
  /** Shown instead when the run isn't live after all (it went quiet or stale). */
  fallback?: React.ReactNode
}

/**
 * What the run is doing right now — "Searching AppDelegate.swift 38s" — as the
 * last line of the chat: in place of the tool group it is adding to, or on its
 * own while it only thinks. It changes as the run moves on.
 *
 * This is deliberately a leaf: it owns the once-a-second clock subscription so
 * that ticking repaints these few spans instead of the whole timeline. Ticking
 * the room itself used to rebuild every code block, which killed any scrollbar
 * drag in progress.
 */
export function AgentActivityBar({ run, botTyping, onLiveChange, fallback = null }: Props) {
  const nowSec = useClockSeconds()
  const activity = agentActivityAt(run, botTyping, nowSec)
  const live = activity !== null

  useEffect(() => {
    onLiveChange(live)
  }, [live, onLiveChange])

  if (!activity) return <>{fallback}</>

  return (
    <div className={`agent-activity agent-activity--${activity.phase}`} aria-live="polite">
      <span className="agent-activity-dot" />
      <span className="agent-activity-label">{activity.label}</span>
      {activity.detail && (
        <span className="agent-activity-detail">{activity.detail}</span>
      )}
      <span className="agent-activity-elapsed">{formatElapsed(activity.elapsedSec)}</span>
    </div>
  )
}
