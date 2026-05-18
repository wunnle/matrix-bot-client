import { useEffect, useState, useRef } from 'react'
import type { RoomToastData } from '../hooks/useRoomToast'
import { getClient } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'

function roomInitial(name: string) {
  return name.trim()[0]?.toUpperCase() ?? '?'
}

interface ToastCardProps {
  toast: RoomToastData
  stackIndex: number   // 0 = top (front), 1 = behind, 2 = further behind
  totalCount: number
  onDismiss: () => void
  onNavigate: (roomId: string) => void
}

function ToastCard({ toast, stackIndex, onDismiss, onNavigate }: ToastCardProps) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

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

  const handleClick = () => {
    if (stackIndex !== 0) return
    onNavigate(toast.roomId)
    onDismiss()
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    if (stackIndex !== 0) return
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (stackIndex !== 0 || !touchStartRef.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - touchStartRef.current.x
    const dy = t.clientY - touchStartRef.current.y
    touchStartRef.current = null
    // Swipe up or right to dismiss
    if (dy < -40 || dx > 60) {
      onDismiss()
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
        <div className="room-toast-body">{toast.body}</div>
      </div>
      {stackIndex === 0 && (
        <button
          className="room-toast-close"
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
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

  // Render at most 3 cards; newest is on top (last in array = stackIndex 0)
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
