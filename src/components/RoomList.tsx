import { useEffect, useState } from 'react'
import type { AuthState } from '../types'
import { fetchJoinedRooms, type RoomSummary } from '../lib/matrix'

interface Props {
  auth: AuthState
  activeRoomId: string | null
  onSelectRoom: (roomId: string, roomName: string) => void
  onSignOut: () => void
}

export default function RoomList({ auth, activeRoomId, onSelectRoom, onSignOut }: Props) {
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchJoinedRooms(auth)
      .then(setRooms)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [auth])

  return (
    <div className="room-list">
      <div className="room-list-header">
        <div className="app-brand">
          <span className="brand-icon">◈</span>
          <span className="brand-name">BotClient</span>
        </div>
        <button className="sign-out" onClick={onSignOut} title="Sign out">↩</button>
      </div>

      <div className="room-list-body">
        {loading && (
          <div className="skeleton-list">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="skeleton-item">
                <div className="skeleton-line wide" />
                <div className="skeleton-line narrow" />
              </div>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}

        <ul>
          {rooms.map((room) => (
            <li
              key={room.roomId}
              className={room.roomId === activeRoomId ? 'active' : ''}
              onClick={() => onSelectRoom(room.roomId, room.name)}
            >
              <div className="room-avatar">{roomInitial(room.name)}</div>
              <div className="room-info">
                <div className="room-name">{room.name}</div>
                {room.lastMessage && (
                  <div className="room-preview">{room.lastMessage}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-footer">
        <div className="user-badge">
          <div className="user-avatar">{auth.userId[1]?.toUpperCase()}</div>
          <div className="user-id">{shortUserId(auth.userId)}</div>
        </div>
      </div>
    </div>
  )
}

function roomInitial(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? '#'
}

function shortUserId(userId: string): string {
  return userId.replace(/^@/, '').split(':')[0]
}
