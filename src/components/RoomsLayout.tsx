import { useNavigate, useParams } from 'react-router-dom'
import { useCallback, useState, useEffect } from 'react'
import type { AuthState } from '../types'
import RoomList from './RoomList'
import ChatView from './ChatView'
import ConnectionBanner from './ConnectionBanner'
import RoomToast from './RoomToast'
import { useRoomToast } from '../hooks/useRoomToast'
import { getClient, getCachedRooms } from '../lib/matrix'
import { getDictationAutoSend, setDictationAutoSend } from '../lib/clientSettings'
import { resolveRoomIdFromParam } from '../lib/roomAliases'

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
  const [dictationAutoSend, setDictationAutoSendState] = useState(() =>
    getDictationAutoSend(auth.userId),
  )
  const roomsReady = getCachedRooms(auth.userId) !== null

  const activeRoomId = roomId
    ? resolveRoomIdFromParam(decodeURIComponent(roomId))
    : null

  const { toasts, dismissTop, dismissAll } = useRoomToast(activeRoomId, clientReady)

  useEffect(() => {
    setDictationAutoSendState(getDictationAutoSend(auth.userId))
  }, [auth.userId])

  const onDictationAutoSendChange = useCallback((value: boolean) => {
    setDictationAutoSendState(value)
    setDictationAutoSend(auth.userId, value)
  }, [auth.userId])

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

  const fetchIntent = useCallback(() => {
    fetch(`/api/room-intent?key=${import.meta.env.VITE_INTENT_SECRET ?? 'construct-intent'}`)
      .then(r => r.json())
      .then(({ room, action }: { room: string | null, action: string | null }) => {
        if (!room) return
        const name = getClient().getRoom(room)?.name ?? room
        setRoomNames(prev => ({ ...prev, [room]: name }))
        const ts = Date.now()
        const query = action === 'voice' ? `?listen=${ts}` : action === 'camera' ? `?camera=${ts}` : ''
        navigate(`/rooms/${encodeURIComponent(room)}${query}`, { replace: true })
      })
      .catch(() => {})
  }, [navigate])

  const handleReady = useCallback(() => {
    setClientReady(true)
    if (roomId) return
    fetchIntent()
  }, [roomId, fetchIntent])

  useEffect(() => {
    if (!clientReady) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchIntent()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [clientReady, fetchIntent])

  return (
    <div className={`layout ${activeRoomId ? 'room-open' : ''}`}>
      <ConnectionBanner />
      {toasts.length > 0 && (
        <RoomToast
          toasts={toasts}
          onDismissTop={dismissTop}
          onDismissAll={dismissAll}
          onNavigate={(id) => {
            const t = toasts[toasts.length - 1]
            if (t) handleSelectRoom(id, t.roomName)
          }}
        />
      )}
      <div className="layout-body">
        <aside className="sidebar">
          <RoomList
            auth={auth}
            activeRoomId={activeRoomId}
            onSelectRoom={handleSelectRoom}
            onSignOut={onSignOut}
            onReady={handleReady}
            dictationAutoSend={dictationAutoSend}
            onDictationAutoSendChange={onDictationAutoSendChange}
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
                dictationAutoSend={dictationAutoSend}
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
