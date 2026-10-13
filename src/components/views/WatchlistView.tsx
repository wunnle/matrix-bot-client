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
  /** Shows only, from TMDB. Says whether more is coming when `next` has no date yet. */
  showStatus?: 'returning' | 'in-production' | 'ended' | 'canceled' | null
  /** Set when a watched show came back because this episode aired. */
  newEpisode?: { season: number, episode: number, airDate: string } | null
  /** When it was made a favorite; favorites lead every list. */
  favoriteAt?: number | null
  /** Wide still for the sheet's header. */
  backdrop?: string | null
  /** Film release or show premiere, YYYY-MM-DD. */
  releaseDate?: string | null
  /** Films: first digital release, in the region or else the US. */
  digital?: { date: string, region: string } | null
  /** Minutes — the film, or one episode. */
  runtime?: number | null
  genres?: string[]
  overview?: string | null
  /** Directors of a film, creators of a show. */
  people?: string[]
  cast?: string[]
  ageRating?: string | null
  /** YouTube video key. */
  trailer?: string | null
  seasons?: number | null
  /** IMDb's rating (via Cinemeta); null for titles too new to have one. */
  // A string ("7.8") in room state — Matrix events can't carry floats.
  imdbRating?: string | number | null
  /** Films only: the cinema run in the region. `now` is TMDB's now-playing list. */
  cinema?: { opens: string | null, now: boolean } | null
}

export type WatchlistAction = 'play' | 'watched' | 'unwatched' | 'remove' | 'favorite' | 'unfavorite'

/** What the service last said about a title, while a tap is in flight or just answered. */
export interface ItemStatus { state: 'pending' | 'ok' | 'failed', action?: WatchlistAction, message?: string }

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  netflix: 'Netflix',
  hbomax: 'HBO Max',
  prime: 'Prime Video',
  apple: 'Apple TV+',
}

// TMDB's own provider logos (from /watch/providers, region TR). Apple TV+ is
// filed there under the Apple TV Store entry, which shares the logo.
const PROVIDER_LOGOS: Record<ProviderKey, string> = {
  netflix: 'https://image.tmdb.org/t/p/w92/rK1KljqmbvO9HQa1PBFLILWah72.png',
  hbomax: 'https://image.tmdb.org/t/p/w92/skypuy7SXuugIQeYg0IglmzoKaS.png',
  prime: 'https://image.tmdb.org/t/p/w92/gMZdpavHmxFNnLpMHwVxfqeux2g.png',
  apple: 'https://image.tmdb.org/t/p/w92/qdEGArH3lKfFnAtYXMkSYk5wxuG.png',
}

function Logos({ providers }: { providers: ProviderKey[] }) {
  return (
    <span className="wl-logos">
      {providers.map((k) => <img key={k} src={PROVIDER_LOGOS[k]} alt={PROVIDER_LABELS[k]} title={PROVIDER_LABELS[k]} />)}
    </span>
  )
}

/** Favorites first, newest favorite first; ties keep the caller's order. */
const byFavorite = (a: WatchlistItem, b: WatchlistItem) =>
  (b.favoriteAt ?? 0) - (a.favoriteAt ?? 0)

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

/** "2h 47m", "58m". */
function runtimeLabel(min?: number | null) {
  if (!min) return null
  const h = Math.floor(min / 60)
  return h ? `${h}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`
}

/** "27 Feb 2024". */
const dateLabel = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

const isFuture = (iso: string, now = new Date()) => new Date(`${iso}T12:00:00`) > now

/**
 * What follows "where" on the card: what decides whether you start it —
 * a film's length, a show's end.
 */
function cardExtra(item: WatchlistItem) {
  return item.kind === 'movie'
    ? runtimeLabel(item.runtime)
    : item.showStatus === 'ended' ? 'Ended' : item.showStatus === 'canceled' ? 'Canceled' : null
}

/** For a film not on your subscriptions: when it is (or was) out to rent or buy. */
function digitalLabel(item: WatchlistItem) {
  if (item.kind !== 'movie' || item.providers?.length || !item.digital) return null
  const where = item.digital.region === 'TR' ? '' : ` (${item.digital.region})`
  return `${isFuture(item.digital.date) ? 'Digital from' : 'Digital since'} ${dateLabel(item.digital.date)}${where}`
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

/** The poster's one badge, most urgent first. */
function badge(item: WatchlistItem) {
  // A watched show only earns a badge once its next episode has a date.
  if (item.watchedAt) return item.next ? `${episode(item.next)} · ${airLabel(item.next.airDate)}` : null
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
  // Favorites first everywhere. Then: shows that came back for a new episode
  // lead, newest episode first.
  const toWatch = inTab.filter((i) => !i.watchedAt).sort((a, b) =>
    byFavorite(a, b)
    || (b.newEpisode?.airDate ?? '').localeCompare(a.newEpisode?.airDate ?? ''))
  // Watched shows lead with what's coming back soonest, then the ones still
  // running without a date, then the finished ones; most recently watched within each.
  const watched = inTab.filter((i) => i.watchedAt).sort((a, b) =>
    byFavorite(a, b)
    || comingBack(a) - comingBack(b)
    || (a.next?.airDate ?? '').localeCompare(b.next?.airDate ?? '')
    || b.watchedAt! - a.watchedAt!)

  // A heart tap shows at once; the service's republished state then agrees.
  const isFavorite = (item: WatchlistItem) => {
    const s = status[item.id]
    return s?.state === 'pending' && (s.action === 'favorite' || s.action === 'unfavorite')
      ? s.action === 'favorite'
      : Boolean(item.favoriteAt)
  }
  const current = items.find((i) => i.id === selected) ?? null

  const card = (item: WatchlistItem) => {
    const s = status[item.id]
    const b = badge(item)
    const extra = cardExtra(item)
    return (
      <button key={item.id} type="button" className="wl-card" onClick={() => setSelected(item.id)}>
        <div className="wl-poster">
          {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <span>{item.title.slice(0, 1)}</span>}
          {b && <span className="wl-badge">{b}</span>}
          {isFavorite(item) && (
            <span className="wl-fav-mark" aria-label="Favorite">
              <span className="material-symbols-outlined" aria-hidden>favorite</span>
            </span>
          )}
          {item.kind === 'movie' && item.imdbRating && <span className="wl-rating">★ {Number(item.imdbRating).toFixed(1)}</span>}
          {s?.state === 'pending' && s.action === 'play' && <span className="wl-poster-status">Starting…</span>}
        </div>
        <span className="wl-card-title">{item.title}</span>
        <span className="wl-card-where">
          {item.providers?.length ? <Logos providers={item.providers} /> : null}
          {/* One service: its name too — a 16px logo alone reads as a dark square. */}
          {item.providers?.length === 1 && !extra && <span>{PROVIDER_LABELS[item.providers[0]]}</span>}
          {!item.providers?.length && <span>{whereLabel(item)}</span>}
          {extra && <span className="wl-card-extra">{extra}</span>}
        </span>
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
            {current.backdrop && (
              <div className="wl-hero"><img src={current.backdrop} alt="" /></div>
            )}
            <div className={`wl-sheet-head${current.backdrop ? ' wl-sheet-head--hero' : ''}`}>
              {current.poster && <img className="wl-sheet-poster" src={current.poster} alt="" />}
              <div className="wl-sheet-info">
                <div className="wl-sheet-title">{current.title}</div>
                <div className="wl-sheet-meta">
                  {[
                    current.year,
                    current.kind === 'series'
                      ? (current.seasons ? `${current.seasons} season${current.seasons > 1 ? 's' : ''}` : 'Series')
                      : runtimeLabel(current.runtime),
                    current.ageRating,
                  ].filter(Boolean).join(' · ')}
                </div>
                {current.imdbRating && (
                  <div className="wl-sheet-score">
                    <span className="wl-sheet-score-num">★ {Number(current.imdbRating).toFixed(1)}</span> IMDb
                  </div>
                )}
              </div>
            </div>

            {current.genres?.length ? (
              <div className="wl-chips">{current.genres.slice(0, 4).map((g) => <span key={g} className="wl-chip">{g}</span>)}</div>
            ) : null}

            <div className="wl-facts">
              <div className="wl-fact">
                <span className="wl-fact-label">Watch on</span>
                {current.providers?.length
                  ? <span className="wl-fact-value"><Logos providers={current.providers} /> {current.providers.map((k) => PROVIDER_LABELS[k]).join(', ')}</span>
                  : <span className="wl-fact-value">{whereLabel(current)}</span>}
              </div>
              {digitalLabel(current) && <div className="wl-fact"><span className="wl-fact-label">Digital</span><span className="wl-fact-value">{digitalLabel(current)!.replace(/^Digital /, '')}</span></div>}
              {current.providers?.length && cinemaLabel(current) ? (
                <div className="wl-fact"><span className="wl-fact-label">Cinemas</span><span className="wl-fact-value">{cinemaLabel(current)}</span></div>
              ) : null}
              {current.newEpisode && !current.watchedAt && (
                <div className="wl-fact wl-fact--new">
                  <span className="wl-fact-label">New</span>
                  <span className="wl-fact-value">{episode(current.newEpisode)} · out {airLabel(current.newEpisode.airDate)}</span>
                </div>
              )}
              {nextLabel(current) && (
                <div className="wl-fact">
                  <span className="wl-fact-label">{current.next ? 'Next' : 'Status'}</span>
                  <span className="wl-fact-value">{nextLabel(current)!.replace(/^Next: /, '')}</span>
                </div>
              )}
            </div>

            <div className="wl-primary">
              {/* A film that is only in cinemas has nothing to play yet. */}
              {!(cinemaLabel(current) && !current.providers?.length) && (
                <button
                  type="button"
                  className="wl-play"
                  disabled={status[current.id]?.state === 'pending' && status[current.id]?.action === 'play'}
                  onClick={() => onAction('play', current.id)}
                >
                  <span className="material-symbols-outlined" aria-hidden>play_arrow</span>
                  {status[current.id]?.state === 'pending' && status[current.id]?.action === 'play' ? 'Starting on the TV…' : 'Play on TV'}
                </button>
              )}
              <button
                type="button"
                className={`wl-fav${isFavorite(current) ? ' wl-fav--on' : ''}`}
                aria-pressed={isFavorite(current)}
                aria-label={isFavorite(current) ? 'Remove from favorites' : 'Add to favorites'}
                onClick={() => onAction(isFavorite(current) ? 'unfavorite' : 'favorite', current.id)}
              >
                <span className="material-symbols-outlined" aria-hidden>favorite</span>
              </button>
            </div>
            {status[current.id]?.message && status[current.id]?.action === 'play' && (
              <div className={`wl-sheet-status${status[current.id].state === 'failed' ? ' wl-sheet-status--failed' : ''}`}>
                {status[current.id].message}
              </div>
            )}

            {(current.overview || current.people?.length || current.cast?.length || current.releaseDate) && (
              <div className="wl-sheet-about">
                {current.overview && <p className="wl-sheet-overview">{current.overview}</p>}
                {current.people?.length ? (
                  <p className="wl-sheet-credit">
                    <span>{current.kind === 'movie' ? 'Directed by' : 'Created by'}</span> {current.people.join(', ')}
                  </p>
                ) : null}
                {current.cast?.length ? <p className="wl-sheet-credit"><span>With</span> {current.cast.join(', ')}</p> : null}
                {current.releaseDate && (
                  <p className="wl-sheet-credit">
                    <span>{current.kind === 'movie' ? (isFuture(current.releaseDate) ? 'Out' : 'Released') : 'Premiered'}</span>{' '}
                    {dateLabel(current.releaseDate)}
                  </p>
                )}
              </div>
            )}

            <div className="wl-secondary">
              {current.trailer && (
                <a className="wl-secondary-btn" href={`https://www.youtube.com/watch?v=${current.trailer}`} target="_blank" rel="noreferrer">
                  <span className="material-symbols-outlined" aria-hidden>smart_display</span>
                  Trailer
                </a>
              )}
              <a className="wl-secondary-btn" href={`https://www.imdb.com/title/${current.id}/`} target="_blank" rel="noreferrer">
                <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                IMDb
              </a>
            </div>

            <div className="message-sheet-actions">
              <button
                type="button"
                className="message-sheet-action"
                onClick={() => { onAction(current.watchedAt ? 'unwatched' : 'watched', current.id); setSelected(null) }}
              >
                <span className="material-symbols-outlined" aria-hidden>{current.watchedAt ? 'undo' : 'check'}</span>
                {current.watchedAt ? 'Back to the list' : 'Mark watched'}
              </button>
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
