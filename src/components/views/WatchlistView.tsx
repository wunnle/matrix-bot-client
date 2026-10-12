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

function whereLabel(item: WatchlistItem) {
  const p = item.providers ?? []
  return p.length ? p.map((k) => PROVIDER_LABELS[k]).join(' · ') : 'Stremio'
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
}

// Adding has no field here: the room's composer stays under the page, and a
// title typed there is the same message to the service as one typed in chat.
export default function WatchlistView({ items, status, onAction, initialSelected, initialShowWatched = false }: Props) {
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null)
  const [showWatched, setShowWatched] = useState(initialShowWatched)

  const toWatch = items.filter((i) => !i.watchedAt)
  const watched = items.filter((i) => i.watchedAt).sort((a, b) => b.watchedAt! - a.watchedAt!)
  const current = items.find((i) => i.id === selected) ?? null

  const card = (item: WatchlistItem) => {
    const s = status[item.id]
    return (
      <button key={item.id} type="button" className="wl-card" onClick={() => setSelected(item.id)}>
        <div className="wl-poster">
          {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <span>{item.title.slice(0, 1)}</span>}
          {item.next && !item.watchedAt && <span className="wl-badge">New ep · {airLabel(item.next.airDate)}</span>}
          {s?.state === 'pending' && <span className="wl-poster-status">Starting…</span>}
        </div>
        <span className="wl-card-title">{item.title}</span>
        <span className="wl-card-where">{whereLabel(item)}</span>
      </button>
    )
  }

  return (
    <div className="room-view wl">
      <div className="wl-section-head wl-section-head--first">
        <span>To watch</span>
        <span className="wl-count">{toWatch.length}</span>
      </div>
      {toWatch.length
        ? <div className="wl-grid">{toWatch.map(card)}</div>
        : <p className="wl-empty">Nothing on the list. Send a title or an IMDb link below.</p>}

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
                  {[current.year, current.kind === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · ')}
                </div>
                <div className="wl-sheet-meta">{whereLabel(current)}</div>
                {current.next && (
                  <div className="wl-sheet-meta">
                    S{current.next.season} E{current.next.episode} · {airLabel(current.next.airDate)}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              className="wl-play"
              disabled={status[current.id]?.state === 'pending'}
              onClick={() => onAction('play', current.id)}
            >
              <span className="material-symbols-outlined" aria-hidden>play_arrow</span>
              {status[current.id]?.state === 'pending' ? 'Starting on the TV…' : 'Play on TV'}
            </button>
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
