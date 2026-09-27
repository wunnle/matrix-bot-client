import { STALE_MS, currentPercent, usageLevel, useMinuteClock, type UsageWindow } from '../hooks/usePlanUsage'

/**
 * A plan window as a line along the chat header's bottom border — the 5-hour
 * window in Claude rooms, Codex's shortest window in Codex rooms.
 */
export function HeaderUsageBar({ window, fetchedAt, label }: {
  window: UsageWindow | null
  fetchedAt: number
  label: string
}) {
  const now = useMinuteClock()
  if (!window) return null
  const percent = currentPercent(window, now)
  const stale = now - fetchedAt > STALE_MS
  return (
    <div
      className={`header-usage header-usage--${usageLevel(percent)}${stale ? ' header-usage--stale' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="header-usage-fill" style={{ width: `${Math.min(percent, 100)}%` }} />
    </div>
  )
}
