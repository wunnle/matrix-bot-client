import { useEffect, useState } from 'react'
import type { PlanUsage, UsageWindow } from '../hooks/usePlanUsage'

// The bot republishes at least every 30 minutes; past an hour of silence the
// numbers are the poller's last word, not the plan's current state.
const STALE_MS = 60 * 60 * 1000

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

function Gauge({ label, window, now }: { label: string, window: UsageWindow, now: number }) {
  const percent = currentPercent(window, now)
  const resets = resetLabel(window.resetsAt, now)
  return (
    <div className={`plan-usage-gauge plan-usage-gauge--${usageLevel(percent)}`}>
      <div className="plan-usage-head">
        <span className="plan-usage-label">{label}</span>
        <span className="plan-usage-percent">{percent}%</span>
      </div>
      <span className="plan-usage-track">
        <span className="plan-usage-fill" style={{ width: `${Math.min(percent, 100)}%` }} />
      </span>
      {resets && <span className="plan-usage-reset">{resets}</span>}
    </div>
  )
}

/** The 5-hour window as a line along the chat header's bottom border. */
export function HeaderUsageBar({ usage }: { usage: PlanUsage | null }) {
  const now = useMinuteClock()
  if (!usage?.session) return null
  const percent = currentPercent(usage.session, now)
  const stale = now - usage.fetchedAt > STALE_MS
  return (
    <div
      className={`header-usage header-usage--${usageLevel(percent)}${stale ? ' header-usage--stale' : ''}`}
      role="meter"
      aria-label="Claude session usage"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="header-usage-fill" style={{ width: `${Math.min(percent, 100)}%` }} />
    </div>
  )
}

export default function PlanUsageMeter({ usage }: { usage: PlanUsage | null }) {
  const now = useMinuteClock()
  if (!usage || (!usage.session && !usage.weekly)) return null
  const stale = now - usage.fetchedAt > STALE_MS
  const title = `Claude plan · checked ${Math.round((now - usage.fetchedAt) / 60_000)} min ago`

  return (
    <div className={`plan-usage${stale ? ' plan-usage--stale' : ''}`} title={title}>
      {usage.session && <Gauge label="Session" window={usage.session} now={now} />}
      {usage.weekly && <Gauge label="Week" window={usage.weekly} now={now} />}
    </div>
  )
}
