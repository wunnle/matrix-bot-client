import { Fragment, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { fold, rankCommands } from '../lib/commandSearch'
import { sheetHost } from '../lib/roomView'
import { isPaletteShortcut } from '../lib/paletteKeys'

/** One row in the palette: a room, an issue, an app action or a message. */
export interface Command {
  id: string
  kind: 'room' | 'issue' | 'action' | 'message'
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
  /** Quiet text on the right, e.g. when a message was sent. */
  meta?: string
  run: () => void
}

const SECTION: Record<Command['kind'], string> = { room: 'Rooms', issue: 'Issues', action: 'Actions', message: 'Messages' }
const EMPTY_QUERY_ROOMS = 6
/** Shorter queries match half of every message. */
const MESSAGE_MIN_QUERY = 2

/**
 * Spotlight-style ⌘K: rooms, Linear issues, app actions and messages.
 *
 * While open it owns the keyboard. A capture listener on window runs before
 * anything else on the page (ChatView's letter-key choice picker, ⌘N in
 * RoomList, the Mac app's ⌘± zoom in App.tsx) and stops every keydown there;
 * typing still reaches the input, since stopping propagation does not cancel
 * the key's default action.
 */
export default function CommandPalette({ commands, searchMessages, onClose }: {
  commands: Command[]
  /** Message hits for a query, newest first; listed after everything else. */
  searchMessages?: (query: string) => Command[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Messages are the slow part; let the typing stay ahead of them.
  const messageQuery = useDeferredValue(query.trim())

  // Grouped by kind, groups in the order of their best hit, so the top result
  // stays on top; messages always last, since they are the long tail.
  const sections = useMemo(() => {
    const q = query.trim()
    let ranked: Command[]
    if (q) {
      ranked = rankCommands(commands, q, 30)
    } else {
      // Nothing typed: the rooms you were just in, then everything you can do.
      // Issues need a query; listed unasked they would bury the rest.
      const rooms = commands.filter((c) => c.kind === 'room')
        .sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0))
        .slice(0, EMPTY_QUERY_ROOMS)
      ranked = [...rooms, ...commands.filter((c) => c.kind === 'action')]
    }
    const groups = new Map<Command['kind'], Command[]>()
    for (const c of ranked) groups.set(c.kind, [...(groups.get(c.kind) ?? []), c])
    const out = [...groups].map(([kind, items]) => ({ title: !q && kind === 'room' ? 'Recent' : SECTION[kind], items }))
    if (searchMessages && messageQuery.length >= MESSAGE_MIN_QUERY && messageQuery === q) {
      const messages = searchMessages(messageQuery)
      if (messages.length) out.push({ title: SECTION.message, items: messages })
    }
    return out
  }, [commands, query, messageQuery, searchMessages])
  const results = useMemo(() => sections.flatMap((s) => s.items), [sections])

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
  let index = -1

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
            placeholder="Search rooms, messages, actions"
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
          {sections.map((section) => (
            <Fragment key={section.title}>
              <div className="cmdk-section" role="presentation">{section.title}</div>
              {section.items.map((cmd) => {
                const i = ++index
                return (
                  <div
                    key={cmd.id}
                    id={`cmdk-${cmd.id}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    className={`cmdk-row cmdk-row--${cmd.kind}${i === activeIndex ? ' cmdk-row--active' : ''}`}
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
                    {cmd.shortcut && <kbd className="cmdk-shortcut">{cmd.shortcut}</kbd>}
                    {cmd.meta && <span className="cmdk-meta">{cmd.meta}</span>}
                  </div>
                )
              })}
            </Fragment>
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

/** The title with the typed text marked: the whole query, else each word. */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = fold(query.trim())
  if (!q) return text
  // Same length as text, so the indexes below mark the original letters.
  const lower = fold(text)
  const words = lower.includes(q) ? [q] : q.split(/\s+/).filter(Boolean)
  const marks: [number, number][] = []
  for (const w of words) {
    const at = lower.indexOf(w)
    if (at >= 0) marks.push([at, at + w.length])
  }
  if (!marks.length) return text
  marks.sort((a, b) => a[0] - b[0])
  const out: ReactNode[] = []
  let pos = 0
  for (const [from, to] of marks) {
    if (from < pos) continue
    out.push(text.slice(pos, from), <mark key={from}>{text.slice(from, to)}</mark>)
    pos = to
  }
  out.push(text.slice(pos))
  return <>{out}</>
}
