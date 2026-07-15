import { useNavigate, useParams } from 'react-router-dom'
import { useCallback, useState, useEffect } from 'react'
import type { AuthState } from '../types'
import RoomList from './RoomList'
import ChatView from './ChatView'
import ConnectionBanner from './ConnectionBanner'
import RoomToast from './RoomToast'
import { useRoomNotifications } from '../hooks/useRoomNotifications'
import { useVisualViewportVars } from '../hooks/useVisualViewport'
import { getClient, getCachedRooms } from '../lib/matrix'
import { getDictationAutoSend, setDictationAutoSend } from '../lib/clientSettings'
import { resolveRoomIdFromParam } from '../lib/roomAliases'

interface Props {
  auth: AuthState
  onSignOut: () => void
}

const MAX_MOUNTED_ROOMS = 5

export default function RoomsLayout({ auth, onSignOut }: Props) {
  useVisualViewportVars()
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

  const { notifications, toasts, dismiss } = useRoomNotifications(activeRoomId, clientReady, auth.userId)

  useEffect(() => {
    setDictationAutoSendState(getDictationAutoSend(auth.userId))
  }, [auth.userId])

  const onDictationAutoSendChange = useCallback((value: boolean) => {
    setDictationAutoSendState(value)
    setDictationAutoSend(auth.userId, value)
  }, [auth.userId])

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

  const handleBack = useCallback(() => {
    navigate('/rooms', { replace: true })
  }, [navigate])

  const fetchIntent = useCallback(() => {
    const secret = import.meta.env.VITE_INTENT_SECRET
    if (!secret) return
    fetch('/api/room-intent', { headers: { 'x-intent-secret': secret } })
      .then(r => r.json())
      .then(({ room, action, text }: { room: string | null, action: string | null, text: string | null }) => {
        if (!room) return
        const name = getClient().getRoom(room)?.name ?? room
        setRoomNames(prev => ({ ...prev, [room]: name }))
        const ts = Date.now()
        const query = action === 'voice' ? `?listen=${ts}` : action === 'camera' ? `?camera=${ts}` : action === 'send' && text ? `?send=${encodeURIComponent(text)}` : ''
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
      {activeRoomId && toasts.length > 0 && (
        <RoomToast
          toasts={toasts}
          onDismiss={dismiss}
          onNavigate={handleSelectRoom}
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
            notifications={notifications}
            onDismissNotification={dismiss}
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
