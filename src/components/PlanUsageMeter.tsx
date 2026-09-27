import { useEffect, useState } from 'react'
import type { PlanUsage, UsageWindow } from '../hooks/usePlanUsage'

// The bot republishes at least every 30 minutes; past an hour of silence the
// numbers are the poller's last word, not the plan's current state.
const STALE_MS = 60 * 60 * 1000

function level(percent: number): string {
  if (percent >= 90) return 'critical'
  if (percent >= 75) return 'warn'
  return 'ok'
}

function resetLabel(resetsAt: number | null, now: number): string {
  if (!resetsAt) return ''
  const ms = resetsAt - now
  if (ms <= 0) return 'resetting'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function Bar({ label, window, now }: { label: string, window: UsageWindow, now: number }) {
  // Once the window has rolled over the stored percent belongs to the old one.
  const rolled = window.resetsAt !== null && window.resetsAt <= now
  const percent = rolled ? 0 : window.percent
  return (
    <div className={`plan-usage-row plan-usage-row--${level(percent)}`}>
      <span className="plan-usage-label">{label}</span>
      <span className="plan-usage-track">
        <span className="plan-usage-fill" style={{ width: `${Math.min(percent, 100)}%` }} />
      </span>
      <span className="plan-usage-percent">{percent}%</span>
    </div>
  )
}

export default function PlanUsageMeter({ usage }: { usage: PlanUsage | null }) {
  // Ticks once a minute so reset countdowns and staleness stay true between
  // publishes, which can be half an hour apart.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  if (!usage || (!usage.session && !usage.weekly)) return null
  const stale = now - usage.fetchedAt > STALE_MS
  const title = [
    usage.session && `Session: ${usage.session.percent}%, resets in ${resetLabel(usage.session.resetsAt, now) || '?'}`,
    usage.weekly && `Week: ${usage.weekly.percent}%, resets in ${resetLabel(usage.weekly.resetsAt, now) || '?'}`,
    `Checked ${Math.round((now - usage.fetchedAt) / 60_000)} min ago`,
  ].filter(Boolean).join('\n')

  return (
    <div className={`plan-usage${stale ? ' plan-usage--stale' : ''}`} title={title}>
      {usage.session && <Bar label="5h" window={usage.session} now={now} />}
      {usage.weekly && <Bar label="wk" window={usage.weekly} now={now} />}
    </div>
  )
}
