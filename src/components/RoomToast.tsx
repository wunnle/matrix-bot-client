import { useEffect, useState, useRef, useCallback } from 'react'
import type { RoomNotification } from '../hooks/useRoomNotifications'
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

interface ToastCardProps {
  notification: RoomNotification
  onDismiss: (roomId: string) => void
  onNavigate: (roomId: string, roomName: string) => void
}

function ToastCard({ notification, onDismiss, onNavigate }: ToastCardProps) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const touchStartY = useRef<number | null>(null)
  const dismissedRef = useRef(false)

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

  return (
    <div
      ref={cardRef}
      className="room-toast"
      onClick={handleClick}
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
        <div className="room-toast-body">{renderInlineMarkdown(notification.body)}</div>
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
}

export default function RoomToast({ toasts, onDismiss, onNavigate }: Props) {
  if (toasts.length === 0) return null

  return (
    <div className="room-toast-stack">
      {toasts.map((n) => (
        <ToastCard
          key={n.roomId}
          notification={n}
          onDismiss={onDismiss}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}
