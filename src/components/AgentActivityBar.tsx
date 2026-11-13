import { useEffect, useState } from 'react'
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
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    onLiveChange(live)
  }, [live, onLiveChange])

  if (!activity) return <>{fallback}</>

  // A command is code: show it with its paths shortened to file names, so the
  // part that says what runs survives the ellipsis. Anything else with spaces
  // is the agent saying what it's doing ("Read the logs"), which already has
  // its verb. A bare path or name ("app.ts") still needs one. Tap for the
  // full text, wrapped.
  const detail = activity.detail?.trim()
  const command = !!detail && looksLikeCommand(detail)
  const prose = !!detail && !command && /\s/.test(detail)
  const shown = detail && !prose && !expanded ? compactPaths(detail) : detail

  return (
    <div
      className={`agent-activity agent-activity--${activity.phase}${expanded ? ' agent-activity--expanded' : ''}`}
      aria-live="polite"
      title={detail}
      onClick={detail ? () => setExpanded(e => !e) : undefined}
    >
      <span className="agent-activity-dot" />
      {!prose && <span className="agent-activity-label">{activity.label}</span>}
      {shown && (
        <span className={`agent-activity-detail${prose ? ' agent-activity-detail--prose' : ''}`}>{shown}</span>
      )}
      <span className="agent-activity-elapsed">{formatElapsed(activity.elapsedSec)}</span>
    </div>
  )
}

const COMMAND_START = /^(sudo\s+)?(python3?|node|bash|sh|npx|npm|uv|jq|git|gh|curl|cd|ls|cat|grep|rg|find|systemctl|journalctl|hermes|linear|vercel)(\s|$)|^(~|\.{1,2})?\//

function looksLikeCommand(s: string): boolean {
  return COMMAND_START.test(s) || /(^|\s)(~|\.{1,2})?\/[\w.-]+\//.test(s)
}

/** "/home/me/.hermes/scripts/places.py" → "places.py", in place, so
 *  `python3 /long/path/places.py search x` reads `python3 places.py search x`. */
function compactPaths(s: string): string {
  return s.replace(/(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)+([\w.@+-]+)/g, '$1')
}
