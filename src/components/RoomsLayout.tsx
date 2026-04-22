import { useNavigate, useParams } from 'react-router-dom'
import { useCallback, useState, useEffect } from 'react'
import type { AuthState } from '../types'
import RoomList from './RoomList'
import ChatView from './ChatView'
import ConnectionBanner from './ConnectionBanner'
import { getClient, getCachedRooms } from '../lib/matrix'

interface Props {
  auth: AuthState
  onSignOut: () => void
}

// Keep the last N visited ChatViews mounted for instant room switching.
// Older rooms get unmounted so their client event listeners, media
// resolutions, and re-renders don't run in the background forever.
const MAX_MOUNTED_ROOMS = 5

export default function RoomsLayout({ auth, onSignOut }: Props) {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const [roomNames, setRoomNames] = useState<Record<string, string>>({})
  const [clientReady, setClientReady] = useState(false)
  const [visitedRooms, setVisitedRooms] = useState<string[]>([])
  const roomsReady = getCachedRooms(auth.userId) !== null

  const activeRoomId = roomId ? decodeURIComponent(roomId) : null

  // Maintain visitedRooms as MRU with the active room at the end.
  useEffect(() => {
    if (!activeRoomId || !clientReady) return
    setVisitedRooms((prev) => {
      const alreadyAtEnd = prev[prev.length - 1] === activeRoomId
      if (alreadyAtEnd && prev.length <= MAX_MOUNTED_ROOMS) return prev
      const filtered = prev.indexOf(activeRoomId) === -1
        ? prev
        : prev.filter((id) => id !== activeRoomId)
      const next = [...filtered, activeRoomId]
      return next.length > MAX_MOUNTED_ROOMS
        ? next.slice(next.length - MAX_MOUNTED_ROOMS)
        : next
    })
  }, [activeRoomId, clientReady])

  function getRoomName(id: string): string {
    try {
      return getClient().getRoom(id)?.name ?? roomNames[id] ?? id
    } catch {
      return roomNames[id] ?? id
    }
  }

  const handleSelectRoom = useCallback((id: string, name: string) => {
    setRoomNames((prev) => (prev[id] === name ? prev : { ...prev, [id]: name }))
    navigate(`/rooms/${encodeURIComponent(id)}`)
  }, [navigate])

  // Use `replace` so the back action doesn't push a new history entry on
  // top of /rooms/:id. On mobile iOS Safari's native edge swipe already
  // pops history as part of the gesture, and our swipe handler used to
  // push /rooms on top of that — two navigations per gesture caused a
  // glitchy "reload" feel during the native swipe animation. With
  // replace, our action is idempotent with the browser's own pop.
  const handleBack = useCallback(() => {
    navigate('/rooms', { replace: true })
  }, [navigate])

  const handleReady = useCallback(() => setClientReady(true), [])

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
            onReady={handleReady}
          />
        </aside>

        <main className="main">
          {visitedRooms.map((id) => (
            <div key={id} style={{ display: id === activeRoomId ? 'contents' : 'none' }}>
              <ChatView
                roomId={id}
                isActive={id === activeRoomId}
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
