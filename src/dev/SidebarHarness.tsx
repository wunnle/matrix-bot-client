import { useEffect, useState } from 'react'
import RoomSidebar, { type SidebarTab } from '../components/RoomSidebar'
import { collectRoomMedia } from '../lib/roomMedia'
import type { Message } from '../types'

// Dev only (main.tsx mounts it for ?sidebar under `vite`): the side panel
// opening and closing beside a stand-in chat, as ChatView drives it, no Matrix
// login. &closed starts it shut, &unseen shows the header's dot, &layout puts
// it in the app's frame with messages and a composer. For frames of the slide,
// &motion=in|out&t=ms holds the panel that far into it.
const params = new URLSearchParams(location.search)
const frozen = params.get('motion') as 'in' | 'out' | null
const layout = params.has('layout')

const at = Date.now() - 3_600_000
const message = (eventId: string, body: string, extra: Partial<Message> = {}): Message => ({
  eventId, sender: '@bot:example.org', body, timestamp: at, isOwnMessage: false, ...extra,
} as Message)
const MESSAGES = [
  message('$a1', 'Published', { artifact: { url: 'https://claude.ai/artifact/abc', title: 'Sidebar motion plan', description: 'Slide in, slide out, one rewrap.' } }),
  message('$a2', 'Published', { artifact: { url: 'https://claude.ai/artifact/def', title: 'Icon candidates' } }),
  message('$l1', 'See https://developer.mozilla.org/en-US/docs/Web/CSS/overflow for clip'),
]
const CHAT = [
  'The panel slides in from the right and back out, the way the swipes move it on the phone.',
  'On a wide screen the chat takes its new width at once, so this paragraph rewraps a single time instead of on every frame of the animation. That is the part that looked jerky when the width itself was animated, because every line of every message reflowed sixty times a second.',
  'Dragging the left edge still resizes it immediately; only a transform moves during the slide.',
]

export default function SidebarHarness() {
  const media = collectRoomMedia(MESSAGES)
  const [tab, setTab] = useState<SidebarTab>('artifacts')
  const [open, setOpen] = useState(!params.has('closed') || frozen === 'in')
  const [motion, setMotion] = useState<'in' | 'out' | null>(frozen)
  const toggle = () => {
    setMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches ? null : open ? 'out' : 'in')
    setOpen(!open)
  }
  useEffect(() => {
    if (!motion || frozen) return
    const timer = setTimeout(() => setMotion(null), 500)
    return () => clearTimeout(timer)
  }, [motion])
  const unseen = !open && params.has('unseen')
  const shell = (
    <div className="chat-shell" style={layout ? undefined : { height: '100vh' }}>
      {frozen && (
        <style>{`.room-sidebar--${frozen} { animation-play-state: paused; animation-delay: -${Number(params.get('t') ?? 0)}ms; }`}</style>
      )}
      <div className="chat-view">
        <div className="chat-header">
          <div className="chat-header-inner">
            <button className="back">←</button>
            <div className="chat-avatar chat-avatar-fallback">B</div>
            <div className="chat-header-info">
              <span className="chat-title">Sidebar polish</span>
              <span className="chat-subtitle">agent/benderdev-209</span>
            </div>
            <button
              type="button"
              className={`header-sidebar${open ? ' header-sidebar--open' : ''}${unseen ? ' header-sidebar--unseen' : ''}`}
              aria-pressed={open}
              onClick={toggle}
            >
              <span className="material-symbols-outlined" aria-hidden>side_navigation</span>
            </button>
          </div>
        </div>
        {layout ? (
          <>
            <div className="messages">
              <div className="messages-inner">
                {CHAT.map((t, i) => (
                  <div key={t} className={`message ${i === 1 ? 'own' : 'other'}`}>
                    <div className="message-body">
                      <div className={`message-pin-surface${i === 1 ? ' message-pin-surface--own' : ''}`}>
                        <div className={i === 1 ? 'bubble' : 'bot-text'}>{t}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="chat-footer">
              <div className="input-row glass">
                <button type="button" className="attach-btn"><span className="material-icons" aria-hidden>attach_file</span></button>
                <textarea rows={1} placeholder="Message…" />
                <button className="send-btn"><span className="send-btn-label">Send</span><span className="send-btn-icon">↑</span></button>
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: 20, display: 'grid', gap: 12 }}>
            {CHAT.map((t) => <div key={t} className="bot-text">{t}</div>)}
          </div>
        )}
      </div>
      {(open || motion === 'out') && (
        <RoomSidebar
          media={media}
          mediaUrls={{}}
          hasMore={false}
          loadingMore={false}
          onLoadMore={() => {}}
          onJump={() => {}}
          onOpenImage={() => {}}
          onClose={toggle}
          motion={motion}
          onMotionEnd={() => { if (!frozen) setMotion(null) }}
          tab={tab}
          onTab={setTab}
          openArtifact={null}
          onOpenArtifact={() => {}}
          browserUrl={null}
          onBrowserUrl={() => {}}
          roomId="!harness:example.org"
        />
      )}
    </div>
  )
  if (!layout) return shell
  // The app's frame around it, as RoomsLayout draws it: the room list, then the room.
  return (
    <div className="layout room-open">
      <div className="layout-body">
        <aside className="sidebar">
          <div style={{ padding: 16, color: 'var(--text-muted)' }}>Room list</div>
        </aside>
        <main className="main">{shell}</main>
      </div>
    </div>
  )
}
