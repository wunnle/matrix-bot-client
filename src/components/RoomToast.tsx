import { useEffect, useState } from 'react'
import type { RoomToastData } from '../hooks/useRoomToast'
import { getClient } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'

function roomInitial(name: string) {
  return name.trim()[0]?.toUpperCase() ?? '?'
}

interface Props {
  toast: RoomToastData
  onDismiss: () => void
  onNavigate: (roomId: string) => void
}

export default function RoomToast({ toast, onDismiss, onNavigate }: Props) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

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
    onNavigate(toast.roomId)
    onDismiss()
  }

  return (
    <div className="room-toast" onClick={handleClick} role="button">
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
      <button
        className="room-toast-close"
        onClick={(e) => { e.stopPropagation(); onDismiss() }}
        aria-label="Dismiss"
      >✕</button>
    </div>
  )
}
