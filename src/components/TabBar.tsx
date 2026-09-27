import type { ReactNode } from 'react'

export type Tab = 'chats' | 'usage' | 'settings'

// Stroked glyphs in the spirit of the SF Symbols iOS uses for these tabs
// (bubble.left.and.bubble.right, gauge, gearshape).
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
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6" />
      <circle cx="12" cy="12" r="6.8" />
    </>
  ),
}

const TABS: { id: Tab, label: string }[] = [
  { id: 'chats', label: 'Chats' },
  { id: 'usage', label: 'Usage' },
  { id: 'settings', label: 'Settings' },
]

/** iOS-style floating tab bar with a liquid-glass capsule. */
export default function TabBar({ active, onSelect }: { active: Tab, onSelect: (tab: Tab) => void }) {
  return (
    <nav className="tab-bar glass" aria-label="Tabs">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          className={`tab-bar-item${id === active ? ' tab-bar-item--active' : ''}`}
          aria-current={id === active ? 'page' : undefined}
          onClick={() => onSelect(id)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[id]}</svg>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}
