import { useState } from 'react'

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
  initialShowWatched?: boolean
  initialTab?: 'series' | 'movie'
}

type Tab = 'series' | 'movie'
const TABS: { id: Tab, label: string }[] = [{ id: 'series', label: 'Shows' }, { id: 'movie', label: 'Movies' }]
const TAB_KEY = 'construct.watchlist.tab'

function savedTab(): Tab {
  try { return localStorage.getItem(TAB_KEY) === 'movie' ? 'movie' : 'series' } catch { return 'series' }
}

const episode = (e: { season: number, episode: number }) => `S${e.season} E${e.episode}`

/** The poster's one badge, most urgent first. */
function badge(item: WatchlistItem) {
  if (item.watchedAt) return null
  if (item.newEpisode) return `New · ${episode(item.newEpisode)}`
  if (item.cinema?.now) return 'In theaters'
  if (item.next) return `${episode(item.next)} · ${airLabel(item.next.airDate)}`
  return null
}

// Adding has no field here: the room's composer stays under the page, and a
// title typed there is the same message to the service as one typed in chat.
export default function WatchlistView({ items, status, onAction, initialSelected, initialShowWatched = false, initialTab }: Props) {
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null)
  const [showWatched, setShowWatched] = useState(initialShowWatched)
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
  const watched = inTab.filter((i) => i.watchedAt).sort((a, b) => b.watchedAt! - a.watchedAt!)
  const current = items.find((i) => i.id === selected) ?? null

  const card = (item: WatchlistItem) => {
    const s = status[item.id]
    const b = badge(item)
    return (
      <button key={item.id} type="button" className="wl-card" onClick={() => setSelected(item.id)}>
        <div className="wl-poster">
          {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <span>{item.title.slice(0, 1)}</span>}
          {b && <span className="wl-badge">{b}</span>}
          {item.kind === 'movie' && item.imdbRating && <span className="wl-rating">★ {Number(item.imdbRating).toFixed(1)}</span>}
          {s?.state === 'pending' && <span className="wl-poster-status">Starting…</span>}
        </div>
        <span className="wl-card-title">{item.title}</span>
        <span className="wl-card-where">{whereLabel(item)}</span>
      </button>
    )
  }

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
          <button type="button" className="wl-section-head wl-section-toggle" onClick={() => setShowWatched((v) => !v)}>
            <span>Watched</span>
            <span className="wl-count">{watched.length}</span>
            <span className="material-symbols-outlined wl-chevron" aria-hidden>{showWatched ? 'expand_less' : 'expand_more'}</span>
          </button>
          {showWatched && <div className="wl-grid wl-grid--watched">{watched.map(card)}</div>}
        </>
      )}

      {current && (
        <div className="room-editor-overlay" onClick={() => setSelected(null)}>
          <div className="room-editor wl-sheet" role="dialog" aria-label={current.title} onClick={(e) => e.stopPropagation()}>
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
                {current.next && (
                  <div className="wl-sheet-meta">
                    Next: {episode(current.next)} · {airLabel(current.next.airDate)}
                  </div>
                )}
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
        </div>
      )}
    </div>
  )
}
