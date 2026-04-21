import { useNavigate, useParams } from 'react-router-dom'
import { useState } from 'react'
import type { AuthState } from '../types'
import RoomList from './RoomList'
import ChatView from './ChatView'
import ConnectionBanner from './ConnectionBanner'
import { getClient, getCachedRooms } from '../lib/matrix'

interface Props {
  auth: AuthState
  onSignOut: () => void
}

export default function RoomsLayout({ auth, onSignOut }: Props) {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const [roomNames, setRoomNames] = useState<Record<string, string>>({})
  const [ready, setReady] = useState(false)

  const activeRoomId = roomId ? decodeURIComponent(roomId) : null

  function getRoomName(id: string): string {
    try {
      return getClient().getRoom(id)?.name ?? roomNames[id] ?? id
    } catch {
      return roomNames[id] ?? id
    }
  }

  function handleSelectRoom(id: string, name: string) {
    setRoomNames((prev) => ({ ...prev, [id]: name }))
    navigate(`/rooms/${encodeURIComponent(id)}`)
  }

  function handleBack() {
    navigate('/rooms')
  }

  return (
    <div className={`layout ${activeRoomId ? 'room-open' : ''}`}>
      <ConnectionBanner />
      <div className="layout-body">
        <aside className="sidebar">
          <RoomList
            auth={auth}
            activeRoomId={activeRoomId}
            onSelectRoom={handleSelectRoom}
            onSignOut={onSignOut}
            onReady={() => setReady(true)}
          />
        </aside>

        <main className="main">
          {!ready ? (
            <div className="empty-state">
              <div className="loading-dots">
                <span /><span /><span />
              </div>
            </div>
          ) : activeRoomId ? (
            <ChatView
              key={activeRoomId}
              roomId={activeRoomId}
              roomName={getRoomName(activeRoomId)}
              userId={auth.userId}
              onBack={handleBack}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-icon">💬</div>
              <p>Select a room to start chatting</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
