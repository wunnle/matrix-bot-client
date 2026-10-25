import { useState } from 'react'
import RoomSidebar, { type SidebarTab } from '../components/RoomSidebar'
import { collectRoomMedia } from '../lib/roomMedia'
import type { Message } from '../types'

// Dev only (main.tsx mounts it for ?browser under `vite`): the room sidebar's
// Browser tab beside a stand-in chat, no Matrix login. ?url= opens a page,
// &refuse=host,host makes the frame check refuse those hosts (there's no /api
// under `vite`), &tab=shared|artifacts starts elsewhere.
const params = new URLSearchParams(location.search)
const refused = new Set((params.get('refuse') ?? '').split(',').filter(Boolean))
const realFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href)
  if (url.pathname !== '/api/frameable') return realFetch(input, init)
  const target = new URL(url.searchParams.get('url') ?? '')
  const body = { frameable: !refused.has(target.hostname), url: target.href }
  return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
}

const at = Date.now() - 3_600_000
const message = (eventId: string, body: string, extra: Partial<Message> = {}): Message => ({
  eventId, sender: '@bot:example.org', body, timestamp: at, isOwnMessage: false, ...extra,
} as Message)
const MESSAGES = [
  message('$a1', 'Published', { artifact: { url: 'https://claude.ai/artifact/abc', title: 'Browser tab plan' } }),
  message('$l1', 'See https://vite.dev/config/server-options for allowedHosts'),
  message('$b1', 'Opened', { browser: { url: 'https://example.com/', title: 'Example' } }),
]

export default function BrowserHarness() {
  const media = collectRoomMedia(MESSAGES)
  const [tab, setTab] = useState<SidebarTab>((params.get('tab') as SidebarTab) || 'browser')
  const [url, setUrl] = useState<string | null>(params.get('url'))
  const [open, setOpen] = useState(true)
  return (
    <div className="chat-shell" style={{ height: '100vh' }}>
      <div className="chat-view">
        <div className="chat-header">
          <div className="chat-header-inner">
            <button className="back">←</button>
            <div className="chat-avatar chat-avatar-fallback">B</div>
            <div className="chat-header-info">
              <span className="chat-title">Browser tab</span>
              <span className="chat-subtitle">agent/benderdev-205</span>
            </div>
            <button type="button" onClick={() => setOpen(!open)}>Panel</button>
          </div>
        </div>
        <div style={{ padding: 20, display: 'grid', gap: 12 }}>
          {['I started the dev server and opened it beside the chat.', 'The header now stays put while the list scrolls. Reload the tab to see it.'].map((t) => (
            <div key={t} className="bot-text">{t}</div>
          ))}
        </div>
      </div>
      {open && (
        <RoomSidebar
          media={media}
          mediaUrls={{}}
          hasMore={false}
          loadingMore={false}
          onLoadMore={() => {}}
          onJump={() => {}}
          onOpenImage={() => {}}
          onClose={() => setOpen(false)}
          tab={tab}
          onTab={setTab}
          openArtifact={null}
          onOpenArtifact={() => {}}
          browserUrl={url}
          onBrowserUrl={setUrl}
          roomId="!harness:example.org"
        />
      )}
    </div>
  )
}
