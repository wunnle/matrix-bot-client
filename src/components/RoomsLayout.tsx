import { useNavigate, useParams } from 'react-router-dom'
import { useCallback, useState, useEffect, useRef } from 'react'
import * as sdk from 'matrix-js-sdk'
import { Capacitor } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import type { AuthState } from '../types'
import RoomList from './RoomList'
import ChatView from './ChatView'
import ConnectionBanner from './ConnectionBanner'
import RoomToast from './RoomToast'
import { useRoomNotifications } from '../hooks/useRoomNotifications'
import { useVisualViewportVars } from '../hooks/useVisualViewport'
import { getClient, getCachedRooms, resyncNow } from '../lib/matrix'
import { getDictationAutoSend, setDictationAutoSend } from '../lib/clientSettings'
import { resolveRoomIdFromParam } from '../lib/roomAliases'
import { isAgentRoom } from '../lib/roomMeta'

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

  // Read inside listeners that must not re-subscribe on every navigation.
  const activeRoomIdRef = useRef<string | null>(activeRoomId)
  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  const { notifications, toasts, dismiss } = useRoomNotifications(activeRoomId, clientReady, auth.userId)

  useEffect(() => {
    setDictationAutoSendState(getDictationAutoSend(auth.userId))
  }, [auth.userId])

  // getRoomName reads the live room object, but nothing re-renders this
  // component when a name changes — so a rename only appeared after navigating
  // away and back. Mirror it into state instead.
  useEffect(() => {
    if (!clientReady) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }

    const onName = (room: sdk.Room) => {
      setRoomNames((prev) => (prev[room.roomId] === room.name ? prev : { ...prev, [room.roomId]: room.name }))
    }

    client.on(sdk.RoomEvent.Name, onName)
    return () => { client.off(sdk.RoomEvent.Name, onName) }
  }, [clientReady])

  // An agent room the bot has left is finished: it can never answer again.
  // Leave it too, so it disappears from the grid instead of lingering as a
  // room only you are still in, and step back to the list if it is open.
  useEffect(() => {
    if (!clientReady) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }

    const reapIfFinished = (roomId: string) => {
      const room = client.getRoom(roomId)
      if (!room || room.getMyMembership() !== 'join') return
      if (!isAgentRoom(client, roomId)) return
      // Only when nobody else is left — a human joining the room shouldn't
      // trigger this when they later leave.
      const others = room.getMembersWithMembership('join').filter((m) => m.userId !== auth.userId)
      if (others.length > 0) return

      if (activeRoomIdRef.current === roomId) navigate('/', { replace: true })
      client.leave(roomId).catch(() => {})
    }

    // The bot's leave lands as a live event only if we were running to see it.
    // End a room with the app closed and that event arrives folded into the
    // next initial sync, so sweep what we already have before listening.
    for (const room of client.getRooms()) reapIfFinished(room.roomId)

    const onMembership = (_event: sdk.MatrixEvent, member: sdk.RoomMember) => {
      if (member.userId === auth.userId) return
      if (member.membership !== 'leave' && member.membership !== 'ban') return
      reapIfFinished(member.roomId)
    }

    client.on(sdk.RoomMemberEvent.Membership, onMembership)
    return () => { client.off(sdk.RoomMemberEvent.Membership, onMembership) }
  }, [clientReady, auth.userId, navigate])

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
    // On foreground, force a sync catch-up before anything else: iOS suspended
    // the WebView (killing the /sync long-poll), so without this the app shows
    // stale cached state for seconds while the SDK waits out its backoff.
    // Hooked to both signals — appStateChange is the reliable native one,
    // visibilitychange also fires for web/tab cases.
    const onForeground = () => { resyncNow(); fetchIntent() }
    const onVisible = () => {
      if (document.visibilityState === 'visible') onForeground()
    }
    document.addEventListener('visibilitychange', onVisible)
    const sub = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) onForeground()
    })
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      void sub.then((s) => s.remove())
    }
  }, [clientReady, fetchIntent])

  // Native deep links (construct://listen?room=...) — from the Control
  // Center "Listen" control. Mirrors the room-intent voice action.
  // The listener attaches immediately (a cold launch from the control can
  // deliver the URL before the client is ready); the navigation is queued
  // in pendingListenRef and applied once clientReady flips true.
  const pendingListenRef = useRef<string | null>(null)
  const clientReadyRef = useRef(false)
  clientReadyRef.current = clientReady

  const goListen = useCallback((room: string) => {
    navigate(`/rooms/${encodeURIComponent(room)}?listen=${Date.now()}`, { replace: true })
  }, [navigate])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    const handleUrl = (url: string) => {
      const match = url.match(/^construct:\/\/listen\?room=([^&]+)/)
      if (!match) return
      const room = decodeURIComponent(match[1]!)
      // Ready → navigate now (warm); otherwise queue for the drain effect (cold).
      if (clientReadyRef.current) goListen(room)
      else pendingListenRef.current = room
    }

    const sub = CapacitorApp.addListener('appUrlOpen', ({ url }) => handleUrl(url))
    CapacitorApp.getLaunchUrl().then((launch) => {
      if (launch?.url) handleUrl(launch.url)
    }).catch(() => {})
    return () => {
      sub.then((h) => h.remove())
    }
  }, [goListen])

  useEffect(() => {
    if (!clientReady || !pendingListenRef.current) return
    const room = pendingListenRef.current
    pendingListenRef.current = null
    goListen(room)
  }, [clientReady, goListen])

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
