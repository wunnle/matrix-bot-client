import { useNavigate, useParams } from 'react-router-dom'
import { useCallback, useState, useEffect, useRef } from 'react'
import * as sdk from 'matrix-js-sdk'
import { Capacitor } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import type { AuthState } from '../types'
import RoomList from './RoomList'
import ChatView from './ChatView'
import ConnectionBanner from './ConnectionBanner'
import UpdateBanner from './UpdateBanner'
import RoomToast from './RoomToast'
import { useRoomNotifications } from '../hooks/useRoomNotifications'
import { useVisualViewportVars } from '../hooks/useVisualViewport'
import { getClient, getCachedRooms, resyncNow } from '../lib/matrix'
import { getDictationAutoSend, setDictationAutoSend } from '../lib/clientSettings'
import { resolveRoomIdFromParam } from '../lib/roomAliases'
import { isAgentRoom } from '../lib/roomMeta'
import { startPresenceHeartbeat, setActiveRoom } from '../lib/presence'

interface Props {
  auth: AuthState
  onSignOut: () => void
}

const MAX_MOUNTED_ROOMS = 5

// Per app launch, not per mount — see the getLaunchUrl call below.
let launchUrlConsumed = false

// The room the user last backed out of, and when. Ambient navigation (a stale
// room-intent) must not undo that. Module scope for the same reason as above:
// it is a property of the app session, not of any one mount.
let lastBack: { room: string, at: number } | null = null
const BACK_SUPPRESS_MS = 10_000

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
    lastBack = null
    navigate(`/rooms/${encodeURIComponent(id)}`)
  }, [navigate])

  // Backing out of a room is a decision; nothing may undo it silently. The
  // room-intent slot lives in serverless module state, so a POST and the GET
  // that clears it can land on different instances and leave a live intent
  // behind — which then re-enters the room you just left, on the very next
  // foreground, and reads as "back does nothing".
  const suppressedByBack = useCallback((room: string) => {
    return lastBack !== null && lastBack.room === room && Date.now() - lastBack.at < BACK_SUPPRESS_MS
  }, [])

  const handleBack = useCallback(() => {
    if (activeRoomIdRef.current) lastBack = { room: activeRoomIdRef.current, at: Date.now() }
    navigate('/rooms', { replace: true })
  }, [navigate])

  const fetchIntent = useCallback(() => {
    const secret = import.meta.env.VITE_INTENT_SECRET
    if (!secret) return
    fetch('/api/room-intent', { headers: { 'x-intent-secret': secret } })
      .then(r => r.json())
      .then(({ room, action, text }: { room: string | null, action: string | null, text: string | null }) => {
        if (!room) return
        if (suppressedByBack(room)) return
        const name = getClient().getRoom(room)?.name ?? room
        setRoomNames(prev => ({ ...prev, [room]: name }))
        const ts = Date.now()
        const query = action === 'voice' ? `?listen=${ts}` : action === 'camera' ? `?camera=${ts}` : action === 'send' && text ? `?send=${encodeURIComponent(text)}` : ''
        navigate(`/rooms/${encodeURIComponent(room)}${query}`, { replace: true })
      })
      .catch(() => {})
  }, [navigate, suppressedByBack])

  const handleReady = useCallback(() => {
    setClientReady(true)
    if (roomId) return
    fetchIntent()
  }, [roomId, fetchIntent])

  // Report foreground presence so the gateway can skip notifying a phone for a
  // message already on screen in whichever client you're using.
  useEffect(() => startPresenceHeartbeat(), [])
  useEffect(() => { setActiveRoom(activeRoomId) }, [activeRoomId])

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

  // Native deep links:
  // - construct://listen?room=... from the Control Center "Listen" control.
  // - construct://room?room=... from notification taps.
  // The listener attaches immediately (a cold launch from the control can
  // deliver the URL before the client is ready); the navigation is queued
  // in pendingDeepLinkRef and applied once clientReady flips true.
  const pendingDeepLinkRef = useRef<{ room: string, listen: boolean } | null>(null)
  const clientReadyRef = useRef(false)
  clientReadyRef.current = clientReady

  const goToRoom = useCallback((room: string, listen = false) => {
    const query = listen ? `?listen=${Date.now()}` : ''
    // A deep link is a deliberate tap, so it overrides the back suppression.
    lastBack = null
    // Replace whatever we launched into with the room list, then push the room
    // on top: back from a notification tap lands on the list instead of
    // dropping straight out of the app.
    navigate('/rooms', { replace: true })
    navigate(`/rooms/${encodeURIComponent(room)}${query}`)
  }, [navigate])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    const handleUrl = (url: string) => {
      const match = url.match(/^construct:\/\/(listen|room)\?room=([^&]+)/)
      if (!match) return
      const action = match[1]!
      const room = decodeURIComponent(match[2]!)
      const listen = action === 'listen'
      // Ready → navigate now (warm); otherwise queue for the drain effect (cold).
      if (clientReadyRef.current) goToRoom(room, listen)
      else pendingDeepLinkRef.current = { room, listen }
    }

    const sub = CapacitorApp.addListener('appUrlOpen', ({ url }) => handleUrl(url))
    // getLaunchUrl() keeps returning the URL the app was launched with for the
    // whole process lifetime, so any remount of this component would re-consume
    // it and throw you back into the launch room. The layout no longer remounts
    // on list ↔ room transitions, but keep the guard: it is what makes that
    // safe rather than a routing detail nobody may ever change back.
    if (!launchUrlConsumed) {
      launchUrlConsumed = true
      CapacitorApp.getLaunchUrl().then((launch) => {
        if (launch?.url) handleUrl(launch.url)
      }).catch(() => {})
    }
    return () => {
      sub.then((h) => h.remove())
    }
  }, [goToRoom])

  useEffect(() => {
    if (!clientReady || !pendingDeepLinkRef.current) return
    const { room, listen } = pendingDeepLinkRef.current
    pendingDeepLinkRef.current = null
    goToRoom(room, listen)
  }, [clientReady, goToRoom])

  return (
    <div className={`layout ${activeRoomId ? 'room-open' : ''}`}>
      <UpdateBanner />
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
