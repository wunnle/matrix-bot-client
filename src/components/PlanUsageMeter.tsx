import { STALE_MS, currentPercent, usageLevel, useMinuteClock, type PlanUsage } from '../hooks/usePlanUsage'

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
