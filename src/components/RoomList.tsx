import { useEffect, useState } from 'react'
import type { AuthState } from '../types'
import { fetchJoinedRooms, type RoomSummary } from '../lib/matrix'

interface Props {
  auth: AuthState
  onSelectRoom: (roomId: string, roomName: string) => void
  onSignOut: () => void
}

export default function RoomList({ auth, onSelectRoom, onSignOut }: Props) {
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
        <h2>Rooms</h2>
        <button className="sign-out" onClick={onSignOut}>Sign out</button>
      </div>

      {loading && <p className="status">Loading rooms…</p>}
      {error && <p className="error">{error}</p>}

      <ul>
        {rooms.map((room) => (
          <li key={room.roomId} onClick={() => onSelectRoom(room.roomId, room.name)}>
            <div className="room-name">{room.name}</div>
            {room.lastMessage && (
              <div className="room-preview">{room.lastMessage}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
