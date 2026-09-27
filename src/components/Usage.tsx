import * as sdk from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'
import {
  STALE_MS, currentPercent, resetLabel, usageLevel, useMinuteClock, usePlanUsage, useCodexUsage,
  type UsageWindow,
} from '../hooks/usePlanUsage'

/**
 * Claude and Codex plan usage, account-wide. The numbers come from the bot, which
 * polls the quotas on the Pi and publishes them as room state (see usePlanUsage); this
 * screen only reads them, so it is as fresh as the bot's last check.
 */

const HOUR = 3_600_000
const WINDOW_MS = { session: 5 * HOUR, weekly: 7 * 24 * HOUR }

function clock(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/**
 * Where the window is heading if usage keeps its average rate so far. Nothing
 * early in a window: a burst in the first minutes projects to nonsense.
 */
function pace(window: UsageWindow, lengthMs: number, now: number): string {
  if (!window.resetsAt) return ''
  const percent = currentPercent(window, now)
  const elapsed = lengthMs - (window.resetsAt - now)
  if (elapsed < lengthMs * 0.05) return ''
  if (percent === 0) return 'Nothing used yet this window.'
  const projected = (percent / elapsed) * lengthMs
  if (percent >= 100) return 'Limit reached.'
  if (projected < 100) return `On pace to end the window at about ${Math.round(projected)}%.`
  const hitAt = now + ((100 - percent) / percent) * elapsed
  return `At this pace you'll hit the limit around ${clock(hitAt, now)}.`
}

function WindowCard({ title, window, lengthMs, now }: {
  title: string
  window: UsageWindow
  lengthMs: number
  now: number
}) {
  const percent = currentPercent(window, now)
  const elapsed = window.resetsAt && lengthMs > 0 ? Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / lengthMs)) : null
  const paceText = pace(window, lengthMs, now)
  return (
    <section className={`settings-section usage-card usage-card--${usageLevel(percent)}`}>
      <div className="usage-card-head">
        <h2 className="settings-section-title">{title}</h2>
        <span className="usage-card-percent">{percent}%</span>
      </div>
      <div className="usage-track">
        <span className="usage-fill" style={{ width: `${Math.min(percent, 100)}%` }} />
        {/* Where the clock is in the window: usage left of this mark is ahead of pace. */}
        {elapsed !== null && <span className="usage-time-mark" style={{ left: `${elapsed * 100}%` }} />}
      </div>
      {window.resetsAt && (
        <p className="usage-card-line">
          Resets {clock(window.resetsAt, now)} · in {resetLabel(window.resetsAt, now)}
        </p>
      )}
      {paceText && <p className="usage-card-hint">{paceText}</p>}
    </section>
  )
}

function windowTitle(minutes: number | null): string {
  if (minutes === 10080) return 'Week'
  if (minutes === 1440) return 'Day'
  if (minutes && minutes % 60 === 0) return `${minutes / 60} hours`
  return minutes ? `${minutes} minutes` : 'Limit'
}

/** "Checked 3 min ago", plus the stale warning once the bot has gone quiet. */
function Freshness({ fetchedAt, now, provider }: { fetchedAt: number, now: number, provider: string }) {
  const checked = Math.max(0, Math.round((now - fetchedAt) / 60_000))
  if (now - fetchedAt > STALE_MS) {
    return (
      <p className="usage-stale">
        Last checked {checked} min ago — the bot may be down or its {provider} login expired.
      </p>
    )
  }
  return <p className="usage-footnote">Checked {checked === 0 ? 'just now' : `${checked} min ago`}.</p>
}

export default function Usage() {
  let client: sdk.MatrixClient | null = null
  try { client = getClient() } catch { /* opened before the client started */ }
  const usage = usePlanUsage(client)
  const codex = useCodexUsage(client)
  const now = useMinuteClock()

  return (
    <div className="settings-screen usage-screen">
      <h1 className="settings-title">Usage</h1>

      {!usage && !codex && (
        <section className="settings-section">
          <p className="settings-empty">
            {client
              ? 'No reading yet. The bot publishes one into an agent room every few minutes.'
              : 'Connecting…'}
          </p>
        </section>
      )}

      {usage && (
        <>
          <h2 className="usage-provider">Claude</h2>
          {usage.session && <WindowCard title="Session · 5 hours" window={usage.session} lengthMs={WINDOW_MS.session} now={now} />}
          {usage.weekly && <WindowCard title="Week · all models" window={usage.weekly} lengthMs={WINDOW_MS.weekly} now={now} />}
          {Object.entries(usage.models).map(([name, w]) => (
            <WindowCard
              key={name}
              title={`Week · ${name[0].toUpperCase()}${name.slice(1)}`}
              window={w}
              lengthMs={WINDOW_MS.weekly}
              now={now}
            />
          ))}
          <Freshness fetchedAt={usage.fetchedAt} now={now} provider="Claude" />
        </>
      )}

      {codex && (
        <>
          <h2 className="usage-provider">OpenAI Codex</h2>
          {codex.windows.map((w, i) => (
            <WindowCard
              key={`${w.minutes}-${i}`}
              title={windowTitle(w.minutes)}
              window={w}
              lengthMs={(w.minutes ?? 0) * 60_000}
              now={now}
            />
          ))}
          <section className="settings-section usage-card">
            <h2 className="settings-section-title">Account</h2>
            {codex.plan && (
              <div className="usage-row">
                <span>Plan</span>
                <span>{codex.plan[0].toUpperCase()}{codex.plan.slice(1)}</span>
              </div>
            )}
            <div className="usage-row">
              <span>Free resets available</span>
              <span className={codex.resetCredits > 0 ? 'usage-on' : 'usage-off'}>{codex.resetCredits}</span>
            </div>
          </section>
          <Freshness fetchedAt={codex.fetchedAt} now={now} provider="Codex" />
        </>
      )}

      {(usage || codex) && (
        <p className="usage-footnote">The bot re-checks every 5 minutes and after each agent turn.</p>
      )}
    </div>
  )
}
