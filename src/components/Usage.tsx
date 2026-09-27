import { useNavigate } from 'react-router-dom'
import * as sdk from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'
import {
  STALE_MS, currentPercent, resetLabel, usageLevel, useMinuteClock, usePlanUsage,
  type ExtraUsage, type UsageWindow,
} from '../hooks/usePlanUsage'

/**
 * Claude plan usage, account-wide. The numbers come from the bot, which polls
 * the quota on the Pi and publishes it as room state (see usePlanUsage); this
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
  const elapsed = window.resetsAt ? Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / lengthMs)) : null
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

function money(minor: number, exponent: number, currency: string | null): string {
  const amount = minor / 10 ** exponent
  try {
    return new Intl.NumberFormat([], { style: 'currency', currency: currency ?? 'USD' }).format(amount)
  } catch {
    return amount.toFixed(exponent)
  }
}

function ExtraCard({ extra }: { extra: ExtraUsage }) {
  const reason = extra.disabledReason?.replace(/_/g, ' ')
  return (
    <section className="settings-section usage-card">
      <h2 className="settings-section-title">Extra usage</h2>
      <p className="settings-section-hint">Credits that keep you working past the plan limits.</p>
      <div className="usage-row">
        <span>Status</span>
        <span className={extra.enabled ? 'usage-on' : 'usage-off'}>
          {extra.enabled ? 'On' : `Off${reason ? ` · ${reason}` : ''}`}
        </span>
      </div>
      {extra.used !== null && extra.limit !== null && (
        <div className="usage-row">
          <span>This month</span>
          <span>{money(extra.used, extra.exponent, extra.currency)} of {money(extra.limit, extra.exponent, extra.currency)}</span>
        </div>
      )}
    </section>
  )
}

export default function Usage() {
  const navigate = useNavigate()
  let client: sdk.MatrixClient | null = null
  try { client = getClient() } catch { /* opened before the client started */ }
  const usage = usePlanUsage(client)
  const now = useMinuteClock()

  const stale = usage ? now - usage.fetchedAt > STALE_MS : false
  const checked = usage ? Math.max(0, Math.round((now - usage.fetchedAt) / 60_000)) : 0

  return (
    <div className="settings-screen usage-screen">
      <header className="settings-header">
        <button className="settings-back" onClick={() => navigate(-1)} aria-label="Back">←</button>
        <h1 className="settings-title">Usage</h1>
      </header>

      {!usage && (
        <section className="settings-section">
          <p className="settings-empty">
            {client
              ? 'No reading yet. The bot publishes one into an agent room every few minutes.'
              : 'Not connected yet. Open the room list, then come back.'}
          </p>
        </section>
      )}

      {usage && (
        <>
          {stale && (
            <p className="usage-stale">
              Last checked {checked} min ago — the bot may be down or its Claude login expired.
            </p>
          )}
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

          {usage.breakdown.length > 0 && (
            <section className="settings-section usage-card">
              <h2 className="settings-section-title">Where this week went</h2>
              {usage.breakdown.map((row) => (
                <div key={row.name} className={`usage-row${row.percent === 0 ? ' usage-row--zero' : ''}`}>
                  <span>{row.name}</span>
                  <span className="usage-row-bar">
                    <span className="usage-track usage-track--thin">
                      <span className="usage-fill" style={{ width: `${Math.min(row.percent, 100)}%` }} />
                    </span>
                    <span className="usage-row-percent">{row.percent}%</span>
                  </span>
                </div>
              ))}
            </section>
          )}

          {usage.extra && <ExtraCard extra={usage.extra} />}

          <p className="usage-footnote">
            Checked {checked === 0 ? 'just now' : `${checked} min ago`}. The bot re-checks every
            5 minutes and after each agent turn.
          </p>
        </>
      )}
    </div>
  )
}
