import { useState } from 'react'
import RoomViewToggle from '../components/RoomViewToggle'
import WatchlistView, { type ItemStatus, type WatchlistItem } from '../components/views/WatchlistView'
import { ROOM_VIEW_COMPOSER_HINT } from '../lib/roomView'
import sample from './watchlist-sample.json'

// Dev only (main.tsx mounts it for ?watchlist under `vite`): the Watchlist room
// page with real titles, no Matrix login. Actions are simulated locally, and the
// footer is a static copy of ChatView's peek + composer markup.
// ?watchlist=<imdb id> opens that title's sheet;
// &tab=movie opens on Movies.
export default function WatchlistHarness() {
  const params = new URLSearchParams(location.search)
  const [items, setItems] = useState<WatchlistItem[]>(sample as WatchlistItem[])
  const [status, setStatus] = useState<Record<string, ItemStatus>>(
    params.get('status') ? { [params.get('watchlist')!]: { state: params.get('status') as ItemStatus['state'], message: params.get('message') ?? undefined } } : {},
  )
  const [showPage, setShowPage] = useState(true)

  return (
    <div className={`chat-view${showPage ? ' chat-view--page' : ''}`} style={{ height: '100vh', ['--footer-h' as string]: '104px' }}>
      <div className="chat-header">
        <div className="chat-header-inner">
          <button className="back">←</button>
          <div className="chat-avatar chat-avatar-fallback">W</div>
          <div className="chat-header-info">
            <span className="chat-title">Watchlist</span>
            <span className="chat-subtitle">{items.filter((i) => !i.watchedAt).length} to watch</span>
          </div>
          <RoomViewToggle showPage={showPage} onChange={setShowPage} />
        </div>
      </div>
      {showPage
        ? (
          <WatchlistView
            items={items}
            status={status}
            initialSelected={params.get('watchlist') || undefined}
            initialTab={params.get('tab') === 'movie' ? 'movie' : 'series'}
            onAction={(action, id) => {
              if (action === 'play') {
                setStatus((s) => ({ ...s, [id]: { state: 'pending' } }))
                setTimeout(() => setStatus((s) => ({ ...s, [id]: { state: 'ok', message: 'Playing on HBO Max' } })), 1500)
              } else if (action === 'remove') {
                setItems((all) => all.filter((i) => i.id !== id))
              } else {
                setItems((all) => all.map((i) => (i.id === id ? { ...i, watchedAt: action === 'watched' ? Date.now() : null } : i)))
              }
            }}
          />
        )
        : <p style={{ padding: 20, color: 'var(--text-muted)' }}>(the room's chat)</p>}
      <div className="chat-footer">
        {showPage && (
          <button type="button" className="room-peek" onClick={() => setShowPage(false)}>
            <span className="room-peek-who">Bender</span>
            <span className="room-peek-body">✓ Watched: Rick and Morty</span>
            <span className="material-symbols-outlined room-peek-open" aria-hidden>expand_less</span>
          </button>
        )}
        <div className="input-row-anchor">
          <div className="input-row glass">
            <button type="button" className="attach-btn"><span className="material-icons" aria-hidden>attach_file</span></button>
            <textarea rows={1} placeholder={showPage ? ROOM_VIEW_COMPOSER_HINT.watchlist : 'Message…'} />
            <button type="button" className="dictation-btn"><span className="material-icons" aria-hidden>mic</span></button>
          </div>
        </div>
      </div>
    </div>
  )
}
