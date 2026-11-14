import { useEffect, useState } from 'react'
import CommandPalette, { type Command } from '../components/CommandPalette'
import { MOD_KEY, isPaletteShortcut } from '../lib/paletteKeys'

// Dev only (main.tsx mounts it for ?palette under `vite`): the ⌘K palette over
// a stand-in room list, no Matrix login. &open starts it open, &q= types into
// it. The last action picked shows under the search button.
const params = new URLSearchParams(location.search)
const now = Date.now()
const min = 60_000

export default function PaletteHarness() {
  const [open, setOpen] = useState(params.has('open'))
  const [picked, setPicked] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (isPaletteShortcut(e)) { e.preventDefault(); setOpen(true) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // What must not fire while the palette is open (stands in for ChatView's
  // letter picker and ⌘N): any letter key reaching window is logged.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteShortcut(e) || !/^[a-z]$/.test(e.key)) return
      setPicked(`leaked key: ${e.metaKey ? '⌘' : ''}${e.key}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pick = (what: string) => () => setPicked(what)
  const room = (id: string, title: string, ago: number, subtitle?: string): Command =>
    ({ id: `room:${id}`, kind: 'room', title, subtitle, recency: now - ago * min, avatar: title[0], run: pick(title) })
  const commands: Command[] = [
    room('h', 'Hermes', 2, 'Morning digest is ready'),
    room('b', 'Bender', 30, 'Lights off in the living room'),
    room('1', 'BEN-386 Construct ⌘K', 1, 'Writing the palette…'),
    room('2', 'BEN-359 Scruffy captures', 90, 'Merged and deployed.'),
    room('3', 'BEN-364 Captures cleanup', 240, 'Usage limit'),
    room('4', 'BEN-385 Sandbox spotlight', 600, 'Archived'),
    room('5', 'Istanbul events', 1440, 'Refreshed for 14 November'),
    room('6', 'Wake schedule display', 3000),
    { id: 'issue:BEN-371', kind: 'issue', title: 'BEN-371', subtitle: 'In Hermes', recency: now - 50 * min, icon: 'tag', run: pick('BEN-371') },
    { id: 'new-claude', kind: 'action', title: 'New Claude Code room', keywords: ['spawn', 'agent', 'create'], icon: 'add', shortcut: MOD_KEY === '⌘' ? '⌘N' : undefined, run: pick('new claude') },
    { id: 'new-codex', kind: 'action', title: 'New Codex room', keywords: ['spawn', 'agent', 'create'], icon: 'add', run: pick('new codex') },
    { id: 'tab-chats', kind: 'action', title: 'Chats', subtitle: 'Tab', keywords: ['rooms', 'home'], icon: 'forum', run: pick('chats') },
    { id: 'tab-usage', kind: 'action', title: 'Usage', subtitle: 'Tab', keywords: ['limits', 'plan', 'quota'], icon: 'speed', run: pick('usage') },
    { id: 'tab-settings', kind: 'action', title: 'Settings', subtitle: 'Tab', keywords: ['preferences', 'account'], icon: 'settings', run: pick('settings') },
    { id: 'reload', kind: 'action', title: 'Reload Construct', keywords: ['refresh'], icon: 'refresh', run: pick('reload') },
  ]

  // Typed in after mount, as a person would, so &q= exercises onChange.
  useEffect(() => {
    const q = params.get('q')
    if (!q || !open) return
    const input = document.querySelector<HTMLInputElement>('.cmdk-input')
    if (!input) return
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, q)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [open])

  return (
    <div style={{ maxWidth: 360, height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)' }}>
      <div className="room-list"><div className="room-list-body">
        <button type="button" className="room-search" onClick={() => setOpen(true)}>
          <span className="material-symbols-outlined" aria-hidden>search</span>
          <span className="room-search-label">Search</span>
          <kbd className="room-search-keys" aria-hidden>{MOD_KEY === '⌘' ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <p style={{ padding: 16, color: 'var(--text-muted)' }} data-testid="picked">{picked || 'Nothing picked'}</p>
      </div></div>
      {open && <CommandPalette commands={commands} onClose={() => setOpen(false)} />}
    </div>
  )
}
