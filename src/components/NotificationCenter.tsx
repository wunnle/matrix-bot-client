import { useState, useEffect, useRef, useCallback } from 'react'
import type { RoomNotification } from '../hooks/useRoomNotifications'
import { getClient } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'

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

const MAX_VISIBLE = 3

function roomInitial(name: string) {
  return name.trim()[0]?.toUpperCase() ?? '?'
}

interface NotifCardProps {
  notification: RoomNotification
  onDismiss: (roomId: string) => void
  onNavigate: (roomId: string, roomName: string) => void
}

function NotifCard({ notification, onDismiss, onNavigate }: NotifCardProps) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const touchStartX = useRef<number | null>(null)
  const dismissedRef = useRef(false)

  useEffect(() => {
    if (!notification.avatarMxc) return
    let cancelled = false
    try {
      const client = getClient()
      // 2× the display size for crisp rendering on high-DPI screens
      resolveMediaUrl(client, notification.avatarMxc, 64, 64, 'crop').then((url) => {
        if (!cancelled) setAvatarUrl(url)
      })
    } catch {}
    return () => { cancelled = true }
  }, [notification.avatarMxc])

  const animateOut = useCallback(() => {
    if (dismissedRef.current) return
    dismissedRef.current = true
    const el = cardRef.current
    if (!el) { onDismiss(notification.roomId); return }
    // Phase 1: slide left
    const height = el.offsetHeight
    el.style.transition = 'transform 0.22s ease, opacity 0.22s ease'
    el.style.transform = 'translateX(-110%)'
    el.style.opacity = '0'
    // Phase 2: collapse height so items below move up smoothly
    setTimeout(() => {
      el.style.transition = 'height 0.18s ease, padding 0.18s ease, margin 0.18s ease'
      el.style.overflow = 'hidden'
      el.style.height = height + 'px'
      requestAnimationFrame(() => {
        el.style.height = '0'
        el.style.paddingTop = '0'
        el.style.paddingBottom = '0'
        el.style.borderBottomWidth = '0'
      })
      setTimeout(() => onDismiss(notification.roomId), 180)
    }, 220)
  }, [notification.roomId, onDismiss])

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    const el = cardRef.current
    if (el) el.style.transition = 'none'
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    const dx = e.touches[0].clientX - touchStartX.current
    if (dx >= 0) return
    const el = cardRef.current
    if (!el) return
    el.style.transform = `translateX(${dx}px)`
    el.style.opacity = String(Math.max(0.2, 1 + dx / 160))
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (dx < -80) {
      animateOut()
    } else {
      const el = cardRef.current
      if (el) {
        el.style.transition = 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s ease'
        el.style.transform = 'translateX(0)'
        el.style.opacity = '1'
      }
    }
  }

  return (
    <div
      ref={cardRef}
      className="notif-card"
      onClick={() => onNavigate(notification.roomId, notification.roomName)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      role="button"
    >
      <div className="notif-card-avatar">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{roomInitial(notification.roomName)}</span>}
      </div>
      <div className="notif-card-content">
        <div className="notif-card-room">{notification.roomName}</div>
        <div className="notif-card-body">{renderInlineMarkdown(notification.body)}</div>
      </div>
      <button
        className="notif-card-close"
        onClick={(e) => { e.stopPropagation(); animateOut() }}
        aria-label="Dismiss"
      >✕</button>
    </div>
  )
}

interface Props {
  notifications: RoomNotification[]
  onDismiss: (roomId: string) => void
  onNavigate: (roomId: string, roomName: string) => void
  position: 'top' | 'bottom'
}

export default function NotificationCenter({ notifications, onDismiss, onNavigate, position }: Props) {
  if (notifications.length === 0) return null

  const visible = notifications.slice(-MAX_VISIBLE)
  const hiddenCount = notifications.length - visible.length

  return (
    <div className={`notif-center notif-center--${position}`}>
      {visible.map((n) => (
        <NotifCard
          key={n.roomId}
          notification={n}
          onDismiss={onDismiss}
          onNavigate={onNavigate}
        />
      ))}
      {hiddenCount > 0 && (
        <div className="notif-center-overflow">+{hiddenCount} more</div>
      )}
    </div>
  )
}
