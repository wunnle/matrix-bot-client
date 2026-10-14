import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Keep in sync with scripts/discord-room/service.mjs.
export const DISCORD_STATE_EVENT = 'com.construct.discord'
export const DISCORD_ACTION_EVENT = 'com.construct.discord.action'

export type DiscordReason = 'mention' | 'reply' | 'role' | 'everyone' | 'urgent'

export interface DiscordItem {
  /** The message's snowflake. */
  id: string
  /** ISO time it was posted. */
  ts: string
  author: string
  channel: string
  thread: string | null
  content: string
  replyTo: { author: string, content: string } | null
  attachments: string[]
  /** Opens the message in Discord. */
  url: string
  /** Why it's an alert; empty for a message kept by link. */
  reasons: DiscordReason[]
  /** Sinan's reaction in Discord: ✅ is done, anything else seen. */
  ack: 'done' | 'seen' | null
  /** He has posted after it in the same thread. */
  answered: boolean
  /** Pending items only. */
  note?: string | null
  pendingAt?: number
}

export interface DiscordState {
  /** Open alerts, newest first. */
  needs: DiscordItem[]
  /** Kept by hand, most recently kept first. */
  pending: DiscordItem[]
  /** Alerts reacted to or answered in the last two days, to keep one if needed. */
  seen: DiscordItem[]
  /** When the collector last read Discord. */
  syncedAt: string | null
}

export type DiscordAction = 'pend' | 'unpend' | 'done' | 'undone'

export interface DiscordStatus { state: 'pending' | 'ok' | 'failed', action?: DiscordAction, message?: string }

const REASON_LABELS: Record<DiscordReason, string> = {
  mention: 'Mention',
  reply: 'Reply',
  role: 'Role ping',
  everyone: '@everyone',
  urgent: 'Urgent',
}

/** The one reason a card shows: the most personal first. */
const REASON_ORDER: DiscordReason[] = ['urgent', 'mention', 'reply', 'role', 'everyone']
const mainReason = (item: DiscordItem) => REASON_ORDER.find((r) => item.reasons.includes(r)) ?? null

/** "now", "12m", "5h", "Tue", "3 Oct". */
function ago(iso: string, now = Date.now()) {
  const ms = now - Date.parse(iso)
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`
  const d = new Date(iso)
  return ms < 6 * 86400000
    ? d.toLocaleDateString('en-GB', { weekday: 'short' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

const where = (item: DiscordItem) => item.thread ? `#${item.channel} › ${item.thread}` : `#${item.channel}`

/** Raw links make a card unreadable; the sheet still shows them. A message
    that is only a link reads as one. */
function preview(text: string) {
  const words = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  return words || (/https?:\/\//.test(text) ? '🔗 Link' : '')
}

/** Initials on a tinted square, the tint fixed per name. Golden-angle steps
    spread similar names around the wheel. */
function Avatar({ name }: { name: string }) {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return (
    <span className="dc-avatar" style={{ ['--dc-hue' as string]: `${Math.round((Math.abs(hash) % 1000) * 137.508) % 360}` }} aria-hidden>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

/** Pull-down-to-close, as the Watchlist sheet. */
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

interface Props {
  state: DiscordState
  status: Record<string, DiscordStatus>
  onAction: (action: DiscordAction, id: string) => void
  /** Opens with this message's sheet up — for the dev harness. */
  initialSelected?: string
}

type Section = 'needs' | 'pending' | 'seen'

// Adding has no field here: a Discord link pasted in the room's composer is
// the same message to the service as one sent in chat.
export default function DiscordView({ state, status, onAction, initialSelected }: Props) {
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const sheet = useDragToClose(sheetRef, () => setSelected(null))

  // A tap shows at once: the item leaves its list while the service answers.
  const moving = (item: DiscordItem) => status[item.id]?.state === 'pending'
  const inFlight = (list: DiscordItem[]) => list.filter((i) => !moving(i))

  const sectionOf = (id: string): Section | null =>
    state.pending.some((i) => i.id === id) ? 'pending'
      : state.needs.some((i) => i.id === id) ? 'needs'
        : state.seen.some((i) => i.id === id) ? 'seen' : null
  const current = [...state.pending, ...state.needs, ...state.seen].find((i) => i.id === selected) ?? null
  const currentSection = current ? sectionOf(current.id) : null

  const card = (item: DiscordItem, section: Section) => {
    const reason = mainReason(item)
    return (
      <div key={item.id} className={`dc-card${section === 'seen' ? ' dc-card--quiet' : ''}`}>
        <button type="button" className="dc-card-main" onClick={() => setSelected(item.id)}>
          <Avatar name={item.author} />
          <span className="dc-card-text">
            <span className="dc-card-top">
              <span className="dc-card-author">{item.author}</span>
              <span className="dc-card-time">{ago(item.ts)}</span>
              {reason && <span className={`dc-reason dc-reason--${reason}`}>{REASON_LABELS[reason]}</span>}
            </span>
            <span className="dc-card-where">{where(item)}</span>
            <span className="dc-card-body">{preview(item.content) || (item.attachments.length ? `📎 ${item.attachments.join(', ')}` : '—')}</span>
            {item.note && <span className="dc-card-note">{item.note}</span>}
          </span>
        </button>
        <div className="dc-card-actions">
          {section !== 'pending' && (
            <button type="button" className="dc-icon-btn" aria-label="Keep as pending" onClick={() => onAction('pend', item.id)}>
              <span className="material-symbols-outlined" aria-hidden>push_pin</span>
            </button>
          )}
          {section !== 'seen' && (
            <button type="button" className="dc-icon-btn" aria-label="Done" onClick={() => onAction('done', item.id)}>
              <span className="material-symbols-outlined" aria-hidden>check</span>
            </button>
          )}
        </div>
      </div>
    )
  }

  const section = (title: string, list: DiscordItem[], kind: Section, empty?: string) => {
    const shown = inFlight(list)
    if (!shown.length && !empty) return null
    return (
      <>
        <div className="wl-section-head">
          <span>{title}</span>
          {shown.length > 0 && <span className="wl-count">{shown.length}</span>}
        </div>
        {shown.length ? <div className="dc-list">{shown.map((i) => card(i, kind))}</div> : <p className="dc-empty">{empty}</p>}
      </>
    )
  }

  const failed = Object.entries(status).find(([, s]) => s.state === 'failed')

  return (
    <div className="room-view dc">
      {failed && <div className="dc-error">{failed[1].message}</div>}
      {section('Needs you', state.needs, 'needs', 'Nothing on Discord needs you.')}
      {section('Pending', state.pending, 'pending')}
      {section('Recently seen', state.seen, 'seen')}
      <p className="dc-synced">
        {state.syncedAt ? `Discord checked ${ago(state.syncedAt)} ago`.replace('now ago', 'just now') : 'Waiting for the first Discord sync'}
      </p>

      {/* Portalled so it sits over the composer and the tab bar too. */}
      {current && createPortal(
        <div className="room-editor-overlay wl-sheet-overlay" onClick={() => setSelected(null)}>
          <div
            ref={sheetRef}
            className="room-editor wl-sheet dc-sheet"
            role="dialog"
            aria-label={`${current.author} in ${where(current)}`}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={sheet.onTouchStart}
            onTouchMove={sheet.onTouchMove}
            onTouchEnd={sheet.onTouchEnd}
          >
            <div className="dc-sheet-head">
              <Avatar name={current.author} />
              <div className="dc-sheet-info">
                <div className="dc-sheet-author">{current.author}</div>
                <div className="dc-sheet-meta">
                  {where(current)} · {new Date(current.ts).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
            {current.replyTo && (
              <div className="dc-sheet-reply">
                <span className="material-symbols-outlined" aria-hidden>reply</span>
                <span><b>{current.replyTo.author}</b> {preview(current.replyTo.content)}</span>
              </div>
            )}
            <p className="dc-sheet-content">{current.content}</p>
            {current.attachments.length > 0 && <p className="dc-sheet-files">📎 {current.attachments.join(', ')}</p>}
            {current.note && <p className="dc-sheet-note"><span>Note</span> {current.note}</p>}
            {(current.ack || current.answered) && (
              <p className="dc-sheet-state">
                {current.answered ? 'You replied after this in Discord.' : current.ack === 'done' ? 'You marked this ✅ in Discord.' : 'You reacted to this in Discord.'}
              </p>
            )}

            <div className="wl-primary">
              <a className="wl-play dc-open" href={current.url} target="_blank" rel="noreferrer">
                <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                Open in Discord
              </a>
            </div>

            <div className="message-sheet-actions">
              {currentSection === 'pending'
                ? (
                  <button type="button" className="message-sheet-action" onClick={() => { onAction('unpend', current.id); setSelected(null) }}>
                    <span className="material-symbols-outlined" aria-hidden>keep_off</span>
                    Not pending
                  </button>
                )
                : (
                  <button type="button" className="message-sheet-action" onClick={() => { onAction('pend', current.id); setSelected(null) }}>
                    <span className="material-symbols-outlined" aria-hidden>push_pin</span>
                    Keep as pending
                  </button>
                )}
              {currentSection !== 'seen' && (
                <button type="button" className="message-sheet-action" onClick={() => { onAction('done', current.id); setSelected(null) }}>
                  <span className="material-symbols-outlined" aria-hidden>check</span>
                  Done
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
