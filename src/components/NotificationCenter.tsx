import { useState, useEffect } from 'react'
import type { RoomNotification } from '../hooks/useRoomNotifications'
import { getClient } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'

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

  useEffect(() => {
    if (!notification.avatarMxc) return
    let cancelled = false
    try {
      const client = getClient()
      resolveMediaUrl(client, notification.avatarMxc, 32, 32, 'crop').then((url) => {
        if (!cancelled) setAvatarUrl(url)
      })
    } catch {}
    return () => { cancelled = true }
  }, [notification.avatarMxc])

  return (
    <div
      className="notif-card"
      onClick={() => onNavigate(notification.roomId, notification.roomName)}
      role="button"
    >
      <div className="notif-card-avatar">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{roomInitial(notification.roomName)}</span>}
      </div>
      <div className="notif-card-content">
        <div className="notif-card-room">{notification.roomName}</div>
        <div className="notif-card-body">{notification.body}</div>
      </div>
      <button
        className="notif-card-close"
        onClick={(e) => { e.stopPropagation(); onDismiss(notification.roomId) }}
        aria-label="Dismiss"
      >✕</button>
    </div>
  )
}

interface Props {
  notifications: RoomNotification[]
  onDismiss: (roomId: string) => void
  onNavigate: (roomId: string, roomName: string) => void
}

export default function NotificationCenter({ notifications, onDismiss, onNavigate }: Props) {
  if (notifications.length === 0) return null

  const visible = notifications.slice(-MAX_VISIBLE)
  const hiddenCount = notifications.length - visible.length

  return (
    <div className="notif-center">
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
