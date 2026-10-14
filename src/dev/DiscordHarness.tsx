import { useState } from 'react'
import RoomViewToggle from '../components/RoomViewToggle'
import DiscordView, { type DiscordItem, type DiscordState, type DiscordStatus } from '../components/views/DiscordView'
import { ROOM_VIEW_COMPOSER_HINT } from '../lib/roomView'
import sample from './discord-sample.json'

// Dev only (main.tsx mounts it for ?discord under `vite`): the Discord room
// page with made-up messages, no Matrix login. Actions are simulated locally,
// and the footer is a static copy of ChatView's peek + composer markup.
// ?discord=<message id> opens that message's sheet; ?discord&empty shows the
// page with nothing waiting.
export default function DiscordHarness() {
  const params = new URLSearchParams(location.search)
  const [state, setState] = useState<DiscordState>(
    params.has('empty') ? { needs: [], pending: [], seen: [], syncedAt: sample.syncedAt } : sample as DiscordState,
  )
  const [status] = useState<Record<string, DiscordStatus>>({})
  const [showPage, setShowPage] = useState(true)

  const take = (id: string) => {
    const all = [...state.needs, ...state.pending, ...state.seen]
    return all.find((i) => i.id === id)!
  }
  const without = (list: DiscordItem[], id: string) => list.filter((i) => i.id !== id)

  return (
    <div className={`chat-view${showPage ? ' chat-view--page' : ''}`} style={{ height: '100vh', ['--footer-h' as string]: '104px' }}>
      <div className="chat-header">
        <div className="chat-header-inner">
          <button className="back">←</button>
          <div className="chat-avatar chat-avatar-fallback">D</div>
          <div className="chat-header-info">
            <span className="chat-title">Discord</span>
            <span className="chat-subtitle">{state.needs.length} need you</span>
          </div>
          <RoomViewToggle showPage={showPage} onChange={setShowPage} />
        </div>
      </div>
      {showPage
        ? (
          <DiscordView
            state={state}
            status={status}
            initialSelected={params.get('discord') || undefined}
            onAction={(action, id) => {
              const item = take(id)
              setState((s) => {
                const rest = { needs: without(s.needs, id), pending: without(s.pending, id), seen: without(s.seen, id) }
                if (action === 'pend') return { ...s, ...rest, pending: [{ ...item, pendingAt: Date.now() }, ...rest.pending] }
                if (action === 'unpend') return { ...s, ...rest, needs: [item, ...rest.needs] }
                return { ...s, ...rest }
              })
            }}
          />
        )
        : <p style={{ padding: 20, color: 'var(--text-muted)' }}>(the room's chat)</p>}
      <div className="chat-footer">
        {showPage && (
          <button type="button" className="room-peek" onClick={() => setShowPage(false)}>
            <span className="room-peek-who">Bender</span>
            <span className="room-peek-body">📌 Pending: Efe in Profile Cleanup Project: initiative done</span>
            <span className="material-symbols-outlined room-peek-open" aria-hidden>expand_less</span>
          </button>
        )}
        <div className="input-row-anchor">
          <div className="input-row glass">
            <button type="button" className="attach-btn"><span className="material-icons" aria-hidden>attach_file</span></button>
            <textarea rows={1} placeholder={showPage ? ROOM_VIEW_COMPOSER_HINT.discord : 'Message…'} />
            <button type="button" className="dictation-btn"><span className="material-icons" aria-hidden>mic</span></button>
          </div>
        </div>
      </div>
    </div>
  )
}
