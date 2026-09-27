import type { ReactNode } from 'react'

export type Tab = 'chats' | 'usage' | 'settings'

// Stroked glyphs in the spirit of the SF Symbols iOS uses for these tabs
// (bubble.left.and.bubble.right, gauge, gear).
const ICONS: Record<Tab, ReactNode> = {
  chats: (
    <>
      <path d="M16 7V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5V12a2.5 2.5 0 0 0 1 2v2.5L6.5 14H9" />
      <path d="M11.5 8h7a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-1 2V19l-2.5-2h-6A2.5 2.5 0 0 1 9 14.5v-4A2.5 2.5 0 0 1 11.5 8z" />
    </>
  ),
  usage: (
    <>
      <path d="M4.2 17.5a9 9 0 1 1 15.6 0" />
      <path d="M12 13.5 16 9" />
      <circle cx="12" cy="13.5" r="1.3" />
    </>
  ),
  // Gear outline from Lucide's `settings` icon (ISC licence).
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
}

const TABS: { id: Tab, label: string }[] = [
  { id: 'chats', label: 'Chats' },
  { id: 'usage', label: 'Usage' },
  { id: 'settings', label: 'Settings' },
]

/** How much of the Claude session window is used, for the live gauge. */
export interface GaugeReading {
  /** 0 (untouched) … 1 (limit reached) — the Usage screen's percentage. */
  used: number
  /** usageLevel() of the used percentage: ok | warn | critical. */
  level: string
}

// The gauge dial: a 240° arc over the top, from lower-left (0%) round to
// lower-right (100%), like a speedometer — so it reads the same way as the
// percentages on the Usage screen.
const CX = 12
const CY = 13.5
const R = 8.5
const START = 210
const SWEEP = 240

function dialPoint(deg: number, r = R): string {
  const rad = (deg * Math.PI) / 180
  return `${(CX + r * Math.cos(rad)).toFixed(2)} ${(CY - r * Math.sin(rad)).toFixed(2)}`
}

/** Clockwise arc from the 0% end to `fraction` of the way round. */
function dialArc(fraction: number): string {
  const end = START - SWEEP * fraction
  const large = SWEEP * fraction > 180 ? 1 : 0
  return `M${dialPoint(START)}A${R} ${R} 0 ${large} 1 ${dialPoint(end)}`
}

/** The usage icon, drawn live: the arc fills and the needle points to how much is used. */
function UsageGauge({ reading }: { reading: GaugeReading }) {
  const fraction = Math.min(1, Math.max(0, reading.used))
  const needle = START - SWEEP * fraction
  return (
    <>
      <path className="gauge-track" d={dialArc(1)} />
      {fraction > 0.01 && <path className={`gauge-fill gauge-fill--${reading.level}`} d={dialArc(fraction)} />}
      <path d={`M${CX} ${CY}L${dialPoint(needle, R - 3.2)}`} />
      <circle cx={CX} cy={CY} r="1.3" />
    </>
  )
}

/** iOS-style floating tab bar with a liquid-glass capsule. */
export default function TabBar({ active, onSelect, gauge }: {
  active: Tab
  onSelect: (tab: Tab) => void
  /** Live session usage; null (no reading, or stale) draws the plain icon. */
  gauge: GaugeReading | null
}) {
  return (
    <nav className="tab-bar glass" aria-label="Tabs">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          className={`tab-bar-item${id === active ? ' tab-bar-item--active' : ''}`}
          aria-current={id === active ? 'page' : undefined}
          aria-label={id === 'usage' && gauge ? `${label}, ${Math.round(gauge.used * 100)}% of session used` : undefined}
          onClick={() => onSelect(id)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {id === 'usage' && gauge ? <UsageGauge reading={gauge} /> : ICONS[id]}
          </svg>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}
