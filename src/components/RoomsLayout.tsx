import { useNavigate, useParams } from 'react-router-dom'
import { useState, useEffect } from 'react'
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
  const [clientReady, setClientReady] = useState(false)
  const [visitedRooms, setVisitedRooms] = useState<string[]>([])
  const roomsReady = getCachedRooms(auth.userId) !== null

  const activeRoomId = roomId ? decodeURIComponent(roomId) : null

  useEffect(() => {
    if (activeRoomId && clientReady) {
      setVisitedRooms((prev) => prev.includes(activeRoomId) ? prev : [...prev, activeRoomId])
    }
  }, [activeRoomId, clientReady])

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
            onReady={() => setClientReady(true)}
          />
        </aside>

        <main className="main">
          {visitedRooms.map((id) => (
            <div key={id} style={{ display: id === activeRoomId ? 'contents' : 'none' }}>
              <ChatView
                roomId={id}
                roomName={getRoomName(id)}
                userId={auth.userId}
                onBack={handleBack}
              />
            </div>
          ))}
          {!activeRoomId && (
            roomsReady ? (
              <div className="empty-state">
                <div className="empty-icon">💬</div>
                <p>Select a room to start chatting</p>
              </div>
            ) : (
              <div className="empty-state">
                <div className="loading-dots"><span /><span /><span /></div>
              </div>
            )
          )}
          {activeRoomId && !clientReady && visitedRooms.length === 0 && (
            <div className="empty-state">
              <div className="loading-dots"><span /><span /><span /></div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
