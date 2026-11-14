import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { rankCommands } from '../lib/commandSearch'
import { sheetHost } from '../lib/roomView'
import { isPaletteShortcut } from '../lib/paletteKeys'

/** One row in the palette: a room, an issue or an app action. */
export interface Command {
  id: string
  kind: 'room' | 'issue' | 'action'
  title: string
  /** Second line: a room's latest message, the room an issue lives in, … */
  subtitle?: string
  /** Matched like the title, but only as substrings. */
  keywords?: string[]
  /** Last activity; the tiebreak between equally good matches. */
  recency?: number
  /** Room avatar URL, or the first letter when there is none. */
  avatar?: string
  /** Material Symbols name, for rows without an avatar. */
  icon?: string
  /** Keyboard shortcut shown on the right, e.g. "⌘N". */
  shortcut?: string
  run: () => void
}

const KIND_LABEL: Record<Command['kind'], string> = { room: 'Room', issue: 'Issue', action: 'Action' }
const EMPTY_QUERY_ROOMS = 8

/**
 * Spotlight-style ⌘K: rooms, Linear issues and app actions in one list.
 *
 * While open it owns the keyboard. A capture listener on window runs before
 * anything else on the page (ChatView's letter-key choice picker, ⌘N in
 * RoomList, the Mac app's ⌘± zoom in App.tsx) and stops every keydown there;
 * typing still reaches the input, since stopping propagation does not cancel
 * the key's default action.
 */
export default function CommandPalette({ commands, onClose }: {
  commands: Command[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    if (query.trim()) return rankCommands(commands, query, 40)
    // Nothing typed: the rooms you were just in, then everything you can do.
    // Issues need a query; listed unasked they would bury the rest.
    const rooms = commands.filter((c) => c.kind === 'room')
      .sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0))
      .slice(0, EMPTY_QUERY_ROOMS)
    return [...rooms, ...commands.filter((c) => c.kind === 'action')]
  }, [commands, query])

  const activeIndex = Math.min(active, Math.max(0, results.length - 1))

  // Keep the onClose/results the listener sees current without re-subscribing.
  const live = useRef({ results, activeIndex, onClose })
  useLayoutEffect(() => { live.current = { results, activeIndex, onClose } })

  // Hand focus back to whatever had it (usually the composer) on close.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    inputRef.current?.focus({ preventScroll: true })
    return () => { previous?.focus?.({ preventScroll: true }) }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      const { results, activeIndex, onClose } = live.current
      if (isPaletteShortcut(e) || e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.isComposing) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'n' || e.key === 'p'))) {
        e.preventDefault()
        if (results.length === 0) return
        const step = e.key === 'ArrowDown' || e.key === 'n' ? 1 : -1
        setActive((activeIndex + step + results.length) % results.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = results[activeIndex]
        if (!cmd) return
        onClose()
        cmd.run()
        return
      }
      // Focus stays in the field: nothing else in the palette needs a keyboard.
      if (e.key === 'Tab') e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  const choose = (cmd: Command) => { onClose(); cmd.run() }
  const activeId = results[activeIndex] ? `cmdk-${results[activeIndex].id}` : undefined

  return createPortal(
    <div className="cmdk-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search rooms and actions">
        <div className="cmdk-field">
          <span className="material-symbols-outlined" aria-hidden>search</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            // A new query starts at the top.
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            placeholder="Search rooms, issues, actions"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={activeId}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          <button type="button" className="cmdk-close" aria-label="Close" onClick={onClose}>
            <span className="cmdk-esc">esc</span>
            <span className="material-symbols-outlined cmdk-close-icon" aria-hidden>close</span>
          </button>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {results.length === 0 && <p className="cmdk-empty">Nothing matches “{query.trim()}”</p>}
          {results.map((cmd, i) => (
            <div
              key={cmd.id}
              id={`cmdk-${cmd.id}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`cmdk-row${i === activeIndex ? ' cmdk-row--active' : ''}`}
              // Mouse-move, not enter: a list scrolling under a still pointer
              // must not steal the selection from the arrow keys.
              onMouseMove={() => { if (i !== activeIndex) setActive(i) }}
              onClick={() => choose(cmd)}
            >
              <span className={`cmdk-icon cmdk-icon--${cmd.kind}`} aria-hidden>
                {cmd.avatar && cmd.avatar.length > 1
                  ? <img src={cmd.avatar} alt="" />
                  : cmd.icon
                    ? <span className="material-symbols-outlined">{cmd.icon}</span>
                    : <span>{cmd.avatar ?? cmd.title.trim()[0]?.toUpperCase()}</span>}
              </span>
              <span className="cmdk-text">
                <span className="cmdk-title"><Highlight text={cmd.title} query={query} /></span>
                {cmd.subtitle && <span className="cmdk-subtitle">{cmd.subtitle}</span>}
              </span>
              {cmd.shortcut
                ? <kbd className="cmdk-shortcut">{cmd.shortcut}</kbd>
                : <span className="cmdk-kind">{KIND_LABEL[cmd.kind]}</span>}
            </div>
          ))}
        </div>
        <div className="cmdk-footer" aria-hidden>
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>,
    sheetHost(),
  )
}

/** The title with the typed text marked, when it appears as is. */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim().toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (at < 0) return text
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>
}
