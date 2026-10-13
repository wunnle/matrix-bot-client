import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Keep in sync with scripts/watchlist/service.mjs.
export const WATCHLIST_STATE_EVENT = 'com.construct.watchlist'
export const WATCHLIST_ACTION_EVENT = 'com.construct.watchlist.action'

export type ProviderKey = 'netflix' | 'hbomax' | 'prime' | 'apple'

export interface WatchlistItem {
  id: string
  kind: 'series' | 'movie'
  title: string
  year: number | null
  poster: string | null
  addedAt: number
  watchedAt: number | null
  /** Subscriptions it is included in. Empty means Stremio. */
  providers?: ProviderKey[]
  next?: { season: number, episode: number, airDate: string } | null
  /** Shows only, from TMDB. Says whether more is coming when `next` has no date yet. */
  showStatus?: 'returning' | 'in-production' | 'ended' | 'canceled' | null
  /** Set when a watched show came back because this episode aired. */
  newEpisode?: { season: number, episode: number, airDate: string } | null
  /** IMDb's rating (via Cinemeta); null for titles too new to have one. */
  // A string ("7.8") in room state — Matrix events can't carry floats.
  imdbRating?: string | number | null
  /** Films only: the cinema run in the region. `now` is TMDB's now-playing list. */
  cinema?: { opens: string | null, now: boolean } | null
}

export type WatchlistAction = 'play' | 'watched' | 'unwatched' | 'remove'

/** What the service last said about a title, while a tap is in flight or just answered. */
export interface ItemStatus { state: 'pending' | 'ok' | 'failed', message?: string }

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  netflix: 'Netflix',
  hbomax: 'HBO Max',
  prime: 'Prime Video',
  apple: 'Apple TV+',
}

/** "In theaters", "In theaters Fri" / "Oct 24" for an upcoming run, else null. */
function cinemaLabel(item: WatchlistItem, now = new Date()) {
  const c = item.cinema
  if (!c || item.watchedAt) return null
  if (c.now) return 'In theaters'
  if (c.opens && new Date(`${c.opens}T12:00:00`) > now) return `In theaters ${airLabel(c.opens, now)}`
  return null
}

function whereLabel(item: WatchlistItem) {
  const p = item.providers ?? []
  if (p.length) return p.map((k) => PROVIDER_LABELS[k]).join(' · ')
  // Not streaming anywhere you pay for: a cinema run says more than the fallback.
  return cinemaLabel(item) ?? 'Stremio'
}

/** "Today", "Sat", or "Oct 24" — the air date as you'd say it. */
function airLabel(iso: string, now = new Date()) {
  const d = new Date(`${iso}T12:00:00`)
  const days = Math.round((d.getTime() - now.getTime()) / 86400000)
  if (days <= 0) return 'Today'
  if (days < 7) return d.toLocaleDateString('en-GB', { weekday: 'short' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

interface Props {
  items: WatchlistItem[]
  status: Record<string, ItemStatus>
  onAction: (action: WatchlistAction, id: string) => void
  /** Opens with this title's sheet up — for the dev harness. */
  initialSelected?: string
  initialTab?: 'series' | 'movie'
}

type Tab = 'series' | 'movie'
const TABS: { id: Tab, label: string }[] = [{ id: 'series', label: 'Shows' }, { id: 'movie', label: 'Movies' }]
const TAB_KEY = 'construct.watchlist.tab'

function savedTab(): Tab {
  try { return localStorage.getItem(TAB_KEY) === 'movie' ? 'movie' : 'series' } catch { return 'series' }
}

const episode = (e: { season: number, episode: number }) => `S${e.season} E${e.episode}`

const STATUS_LABELS: Record<NonNullable<WatchlistItem['showStatus']>, string> = {
  'returning': 'Returning · no date yet',
  'in-production': 'In production · no date yet',
  'ended': 'Ended',
  'canceled': 'Canceled',
}

/** What's coming for a show: the dated next episode, else whether more is coming at all. */
function nextLabel(item: WatchlistItem) {
  if (item.kind !== 'series') return null
  if (item.next) return `Next: ${episode(item.next)} · ${airLabel(item.next.airDate)}`
  return item.showStatus ? STATUS_LABELS[item.showStatus] : null
}

/** Sort rank for a watched title: 0 has a dated next episode, 1 is still running, 2 is over or unknown. */
function comingBack(item: WatchlistItem) {
  if (item.next) return 0
  return item.showStatus === 'returning' || item.showStatus === 'in-production' ? 1 : 2
}

/**
 * Whether the poster gets its corner flag: something has happened or has a
 * date — a new episode, a dated next one, a cinema run. The sheet says which.
 */
function flagged(item: WatchlistItem) {
  if (item.next) return true
  if (item.watchedAt) return false
  return Boolean(item.newEpisode || item.cinema?.now)
}

/**
 * Pull-down-to-close for a bottom sheet. Only starts when the sheet is
 * scrolled to the top, so scrolling its content still works; past the
 * threshold it slides out and calls onClose, otherwise it springs back.
 */
function useDragToClose(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  const drag = useRef<{ y: number, dy: number } | null>(null)
  const set = (transform: string, transition: string) => {
    if (!ref.current) return
    ref.current.style.transition = transition
    ref.current.style.transform = transform
  }
  return {
    onTouchStart: (e: React.TouchEvent) => {
      if ((ref.current?.scrollTop ?? 0) > 0) return
      drag.current = { y: e.touches[0].clientY, dy: 0 }
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!drag.current) return
      drag.current.dy = Math.max(0, e.touches[0].clientY - drag.current.y)
      set(`translateY(${drag.current.dy}px)`, 'none')
    },
    onTouchEnd: () => {
      const dy = drag.current?.dy ?? 0
      drag.current = null
      if (dy > 90) {
        set('translateY(100%)', 'transform 0.18s ease-in')
        setTimeout(onClose, 180)
      } else if (dy > 0) {
        set('translateY(0)', 'transform 0.2s ease-out')
      }
    },
  }
}

// Adding has no field here: the room's composer stays under the page, and a
// title typed there is the same message to the service as one typed in chat.
export default function WatchlistView({ items, status, onAction, initialSelected, initialTab }: Props) {
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null)
  const [tab, setTab] = useState<Tab>(() => initialTab ?? savedTab())
  const pickTab = (t: Tab) => {
    setTab(t)
    try { localStorage.setItem(TAB_KEY, t) } catch { /* private mode: just don't remember */ }
  }

  const ofKind = (t: Tab) => items.filter((i) => (t === 'movie') === (i.kind === 'movie'))
  const inTab = ofKind(tab)
  // Shows that came back for a new episode lead, newest episode first.
  const toWatch = inTab.filter((i) => !i.watchedAt)
    .sort((a, b) => (b.newEpisode?.airDate ?? '').localeCompare(a.newEpisode?.airDate ?? ''))
  // Watched shows lead with what's coming back soonest, then the ones still
  // running without a date, then the finished ones; most recently watched within each.
  const watched = inTab.filter((i) => i.watchedAt).sort((a, b) =>
    comingBack(a) - comingBack(b)
    || (a.next?.airDate ?? '').localeCompare(b.next?.airDate ?? '')
    || b.watchedAt! - a.watchedAt!)
  const current = items.find((i) => i.id === selected) ?? null
  const sheetRef = useRef<HTMLDivElement>(null)
  const sheet = useDragToClose(sheetRef, () => setSelected(null))

  // Posters only: the art already carries the title, and the sheet has the rest.
  const card = (item: WatchlistItem) => (
    <button key={item.id} type="button" className="wl-card" aria-label={item.title} onClick={() => setSelected(item.id)}>
      <div className="wl-poster">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <span className="wl-poster-title">{item.title}</span>}
        {flagged(item) && <span className="wl-flag" aria-hidden />}
        {item.kind === 'movie' && item.imdbRating && <span className="wl-rating">★ {Number(item.imdbRating).toFixed(1)}</span>}
        {status[item.id]?.state === 'pending' && <span className="wl-poster-status">Starting…</span>}
      </div>
    </button>
  )

  return (
    <div className="room-view wl">

      <div className="wl-tabs" role="tablist" aria-label="Kind">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'wl-tab wl-tab--on' : 'wl-tab'}
            onClick={() => pickTab(t.id)}
          >
            {t.label}
            <span className="wl-count">{ofKind(t.id).filter((i) => !i.watchedAt).length}</span>
          </button>
        ))}
      </div>

      {toWatch.length
        ? <div className="wl-grid">{toWatch.map(card)}</div>
        : <p className="wl-empty">No {tab === 'movie' ? 'movies' : 'shows'} to watch. Send a title or an IMDb link below.</p>}

      {watched.length > 0 && (
        <>
          <div className="wl-section-head">
            <span>Watched</span>
            <span className="wl-count">{watched.length}</span>
          </div>
          <div className="wl-row">{watched.map(card)}</div>
        </>
      )}

      {/* Portalled so it sits over the composer and the tab bar too. */}
      {current && createPortal(
        <div className="room-editor-overlay wl-sheet-overlay" onClick={() => setSelected(null)}>
          <div
            ref={sheetRef}
            className="room-editor wl-sheet"
            role="dialog"
            aria-label={current.title}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={sheet.onTouchStart}
            onTouchMove={sheet.onTouchMove}
            onTouchEnd={sheet.onTouchEnd}
          >
            <div className="wl-sheet-head">
              {current.poster && <img className="wl-sheet-poster" src={current.poster} alt="" />}
              <div className="wl-sheet-info">
                <div className="wl-sheet-title">{current.title}</div>
                <div className="wl-sheet-meta">
                  {[
                    current.year,
                    current.kind === 'series' ? 'Series' : 'Film',
                    current.imdbRating ? `IMDb ${Number(current.imdbRating).toFixed(1)}` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                <div className="wl-sheet-meta">{whereLabel(current)}</div>
                {current.providers?.length && cinemaLabel(current)
                  ? <div className="wl-sheet-meta">{cinemaLabel(current)}</div>
                  : null}
                {current.newEpisode && !current.watchedAt && (
                  <div className="wl-sheet-meta wl-sheet-meta--new">
                    New: {episode(current.newEpisode)} · out {airLabel(current.newEpisode.airDate)}
                  </div>
                )}
                {nextLabel(current) && <div className="wl-sheet-meta">{nextLabel(current)}</div>}
              </div>
            </div>

            {/* A film that is only in cinemas has nothing to play yet. */}
            {!(cinemaLabel(current) && !current.providers?.length) && (
              <button
                type="button"
                className="wl-play"
                disabled={status[current.id]?.state === 'pending'}
                onClick={() => onAction('play', current.id)}
              >
                <span className="material-symbols-outlined" aria-hidden>play_arrow</span>
                {status[current.id]?.state === 'pending' ? 'Starting on the TV…' : 'Play on TV'}
              </button>
            )}
            {status[current.id]?.message && (
              <div className={`wl-sheet-status${status[current.id].state === 'failed' ? ' wl-sheet-status--failed' : ''}`}>
                {status[current.id].message}
              </div>
            )}

            <div className="message-sheet-actions">
              <button
                type="button"
                className="message-sheet-action"
                onClick={() => { onAction(current.watchedAt ? 'unwatched' : 'watched', current.id); setSelected(null) }}
              >
                <span className="material-symbols-outlined" aria-hidden>{current.watchedAt ? 'undo' : 'check'}</span>
                {current.watchedAt ? 'Back to the list' : 'Mark watched'}
              </button>
              <a className="message-sheet-action" href={`https://www.imdb.com/title/${current.id}/`} target="_blank" rel="noreferrer">
                <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                IMDb
              </a>
              <button
                type="button"
                className="message-sheet-action wl-remove"
                onClick={() => { onAction('remove', current.id); setSelected(null) }}
              >
                <span className="material-symbols-outlined" aria-hidden>delete</span>
                Remove
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
