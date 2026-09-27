import { useEffect, useState, useRef, useCallback } from 'react'
import type { RoomNotification } from '../hooks/useRoomNotifications'
import { actionLabel } from '../lib/actions'
import { getClient } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'

function roomInitial(name: string) {
  return name.trim()[0]?.toUpperCase() ?? '?'
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~)/g
  let last = 0, match: RegExpExecArray | null, key = 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[2] !== undefined) parts.push(<strong key={key++}>{match[2]}</strong>)
    else if (match[3] !== undefined) parts.push(<em key={key++}>{match[3]}</em>)
    else if (match[4] !== undefined) parts.push(<code key={key++}>{match[4]}</code>)
    else if (match[5] !== undefined) parts.push(<s key={key++}>{match[5]}</s>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// Buttons ignore taps this soon after a toast appears or changes: it drops in
// under a cursor or thumb that was aiming at something else, and one of those
// buttons may be Approve.
const ARM_DELAY_MS = 600

// How long the tapped button shows its checkmark before the toast leaves.
const CONFIRM_MS = 700

// Answers that say no get the quieter button style.
const DECLINE = /^(deny|no|cancel|reject|decline|skip|ignore|dismiss|stop)\b/i

interface ToastCardProps {
  notification: RoomNotification
  onDismiss: (roomId: string) => void
  onNavigate: (roomId: string, roomName: string) => void
  onHold: (roomId: string, held: boolean) => void
  onRespond: (roomId: string, label: string) => Promise<void>
}

function ToastCard({ notification, onDismiss, onNavigate, onHold, onRespond }: ToastCardProps) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  // Cards are keyed by room, so a newer message replaces this one's content in
  // place. Send state is tagged with the message it belongs to, so it resets
  // by itself when that happens.
  const [attempt, setAttempt] = useState<{ eventId: string; label: string | null; failed: boolean; sent: boolean } | null>(null)
  const current = attempt?.eventId === notification.eventId ? attempt : null
  const sending = current?.label ?? null
  const sent = current?.sent ?? false
  const error = current?.failed ?? false
  const cardRef = useRef<HTMLDivElement>(null)
  const touchStartY = useRef<number | null>(null)
  const dismissedRef = useRef(false)
  // performance.now() time the current message appeared; compared against the
  // click's own timeStamp, which is on the same clock.
  const shownAtRef = useRef(0)
  useEffect(() => { shownAtRef.current = performance.now() }, [notification.eventId])

  const respond = async (label: string, at: number) => {
    if (sending || at - shownAtRef.current < ARM_DELAY_MS) return
    const eventId = notification.eventId
    setAttempt({ eventId, label, failed: false, sent: false })
    try {
      await onRespond(notification.roomId, label)
      // A checkmark on the tapped button is the confirmation; the bot's own
      // "✅ Approved" reply is machine-flagged and doesn't toast.
      setAttempt({ eventId, label, failed: false, sent: true })
      setTimeout(() => animateOut(), CONFIRM_MS)
    } catch {
      setAttempt({ eventId, label: null, failed: true, sent: false })
    }
  }

  useEffect(() => {
    if (!notification.avatarMxc) return
    let cancelled = false
    try {
      const client = getClient()
      resolveMediaUrl(client, notification.avatarMxc, 48, 48, 'crop').then((url) => {
        if (!cancelled) setAvatarUrl(url)
      })
    } catch {}
    return () => { cancelled = true }
  }, [notification.avatarMxc])

  const animateOut = useCallback((dy = -100) => {
    if (dismissedRef.current) return
    dismissedRef.current = true
    const el = cardRef.current
    if (!el) { onDismiss(notification.roomId); return }
    el.style.transition = 'transform 0.22s cubic-bezier(0.4,0,1,1), opacity 0.22s ease'
    el.style.transform = `translateY(${Math.min(dy, -60)}px)`
    el.style.opacity = '0'
    setTimeout(() => onDismiss(notification.roomId), 220)
  }, [notification.roomId, onDismiss])

  const handleClick = () => {
    onNavigate(notification.roomId, notification.roomName)
    animateOut()
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
    const el = cardRef.current
    if (el) el.style.transition = 'none'
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return
    const dy = e.touches[0].clientY - touchStartY.current
    if (dy >= 0) return
    const el = cardRef.current
    if (!el) return
    el.style.transform = `translateY(${dy}px)`
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dy) / 160))
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return
    const dy = e.changedTouches[0].clientY - touchStartY.current
    touchStartY.current = null
    if (dy < -60) {
      animateOut(dy)
    } else {
      const el = cardRef.current
      if (el) {
        el.style.transition = 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s ease'
        el.style.transform = 'translateY(0)'
        el.style.opacity = '1'
      }
    }
  }

  const { lines, code, actions, approval } = notification

  return (
    <div
      ref={cardRef}
      className={`room-toast${approval ? ' room-toast-approval' : ''}`}
      onClick={handleClick}
      onMouseEnter={() => onHold(notification.roomId, true)}
      onMouseLeave={() => onHold(notification.roomId, false)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      role="button"
    >
      <div className="room-toast-avatar">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{roomInitial(notification.roomName)}</span>}
      </div>
      <div className="room-toast-content">
        <div className="room-toast-header">
          <span className="room-toast-room">{notification.roomName}</span>
          <span className="room-toast-sender">{notification.senderName}</span>
        </div>
        {(lines.length ? lines : [notification.body]).map((line, i) => (
          <div key={i} className="room-toast-body">{renderInlineMarkdown(line)}</div>
        ))}
        {code && <pre className="room-toast-code">{code}</pre>}
        {approval?.lines && (
          <button
            className="room-toast-more"
            onClick={(e) => { e.stopPropagation(); handleClick() }}
          >
            View all {approval.lines} lines
          </button>
        )}
        {actions.length > 0 && (
          <div className="room-toast-actions">
            {actions.map((label) => (
              <button
                key={label}
                className={`room-toast-action${DECLINE.test(label) ? ' room-toast-action-secondary' : ''}${sent && sending === label ? ' room-toast-action-done' : ''}`}
                disabled={sending !== null}
                // Keeps a focused composer focused, like the chat's pills.
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); void respond(label, e.timeStamp) }}
                onTouchStart={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
              >
                {sending === label ? (sent ? `✓ ${actionLabel(label)}` : '…') : actionLabel(label)}
              </button>
            ))}
          </div>
        )}
        {error && <div className="room-toast-error">Couldn't send — try again</div>}
      </div>
      <button
        className="room-toast-close"
        onClick={(e) => { e.stopPropagation(); animateOut() }}
        aria-label="Dismiss"
      >✕</button>
    </div>
  )
}

interface Props {
  toasts: RoomNotification[]
  onDismiss: (roomId: string) => void
  onNavigate: (roomId: string, roomName: string) => void
  onHold: (roomId: string, held: boolean) => void
  onRespond: (roomId: string, label: string) => Promise<void>
}

export default function RoomToast({ toasts, onDismiss, onNavigate, onHold, onRespond }: Props) {
  if (toasts.length === 0) return null

  return (
    <div className="room-toast-stack">
      {toasts.map((n) => (
        <ToastCard
          key={n.roomId}
          notification={n}
          onDismiss={onDismiss}
          onNavigate={onNavigate}
          onHold={onHold}
          onRespond={onRespond}
        />
      ))}
    </div>
  )
}
