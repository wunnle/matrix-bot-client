import { useEffect, useState, useRef, useCallback } from 'react'
import type { RoomToastData } from '../hooks/useRoomToast'
import { getClient } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'

function roomInitial(name: string) {
  return name.trim()[0]?.toUpperCase() ?? '?'
}

// Render inline markdown: **bold**, *italic*, `code`, ~~strike~~
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // Pattern matches bold, italic, code, strikethrough in order of precedence
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
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
  toast: RoomToastData
  stackIndex: number
  totalCount: number
  onDismiss: () => void
  onNavigate: (roomId: string) => void
}

function ToastCard({ toast, stackIndex, onDismiss, onNavigate }: ToastCardProps) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const draggingRef = useRef(false)
  const dismissedRef = useRef(false)

  useEffect(() => {
    if (!toast.avatarMxc) return
    let cancelled = false
    try {
      const client = getClient()
      resolveMediaUrl(client, toast.avatarMxc, 48, 48, 'crop').then((url) => {
        if (!cancelled) setAvatarUrl(url)
      })
    } catch {}
    return () => { cancelled = true }
  }, [toast.avatarMxc])

  const animateOut = useCallback((dy: number) => {
    if (dismissedRef.current) return
    dismissedRef.current = true
    const el = cardRef.current
    if (!el) { onDismiss(); return }
    const exitY = Math.min(dy, -100)
    el.style.transition = 'transform 0.22s cubic-bezier(0.4,0,1,1), opacity 0.22s ease'
    el.style.transform = `translateY(${exitY}px) scale(0.9)`
    el.style.opacity = '0'
    setTimeout(onDismiss, 220)
  }, [onDismiss])

  const handleClick = () => {
    if (stackIndex !== 0 || draggingRef.current) return
    onNavigate(toast.roomId)
    animateOut(-80)
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    if (stackIndex !== 0) return
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
    draggingRef.current = false
    const el = cardRef.current
    if (el) el.style.transition = 'none'
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (stackIndex !== 0 || !touchStartRef.current) return
    const t = e.touches[0]
    const dy = t.clientY - touchStartRef.current.y
    if (dy >= 0) return // only track upward movement
    draggingRef.current = true
    const el = cardRef.current
    if (!el) return
    const opacity = Math.max(0.2, 1 - Math.abs(dy) / 160)
    el.style.transform = `translateY(${dy}px)`
    el.style.opacity = String(opacity)
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (stackIndex !== 0 || !touchStartRef.current) return
    const t = e.changedTouches[0]
    const dy = t.clientY - touchStartRef.current.y
    touchStartRef.current = null
    const el = cardRef.current

    if (dy < -60) {
      animateOut(dy)
    } else {
      draggingRef.current = false
      if (el) {
        el.style.transition = 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s ease'
        el.style.transform = 'translateY(0)'
        el.style.opacity = '1'
      }
    }
  }

  const scale = 1 - stackIndex * 0.04
  const translateY = stackIndex * -8
  const opacity = stackIndex > 2 ? 0 : 1 - stackIndex * 0.15
  const zIndex = 100 - stackIndex

  return (
    <div
      ref={cardRef}
      className={`room-toast ${stackIndex === 0 ? 'room-toast--top' : 'room-toast--behind'}`}
      style={{
        transform: `translateY(${translateY}px) scale(${scale})`,
        opacity,
        zIndex,
        pointerEvents: stackIndex === 0 ? 'auto' : 'none',
      }}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      role={stackIndex === 0 ? 'button' : undefined}
    >
      <div className="room-toast-avatar">
        {avatarUrl
          ? <img src={avatarUrl} alt="" />
          : <span>{roomInitial(toast.roomName)}</span>}
      </div>
      <div className="room-toast-content">
        <div className="room-toast-header">
          <span className="room-toast-room">{toast.roomName}</span>
          <span className="room-toast-sender">{toast.senderName}</span>
        </div>
        <div className="room-toast-body">{renderInlineMarkdown(toast.body)}</div>
      </div>
      {stackIndex === 0 && (
        <button
          className="room-toast-close"
          onClick={(e) => { e.stopPropagation(); animateOut(-80) }}
          aria-label="Dismiss"
        >✕</button>
      )}
    </div>
  )
}

interface Props {
  toasts: RoomToastData[]
  onDismissTop: () => void
  onDismissAll: () => void
  onNavigate: (roomId: string) => void
}

export default function RoomToast({ toasts, onDismissTop, onNavigate }: Props) {
  if (toasts.length === 0) return null

  const visible = toasts.slice(-3)

  return (
    <div className="room-toast-stack">
      {visible.map((toast, i) => {
        const stackIndex = visible.length - 1 - i
        return (
          <ToastCard
            key={toast.id}
            toast={toast}
            stackIndex={stackIndex}
            totalCount={toasts.length}
            onDismiss={onDismissTop}
            onNavigate={onNavigate}
          />
        )
      })}
      {toasts.length > 1 && (
        <div className="room-toast-count">{toasts.length}</div>
      )}
    </div>
  )
}
