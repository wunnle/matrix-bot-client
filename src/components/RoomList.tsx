import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { AuthState } from '../types'
import { fetchJoinedRooms, getCachedRooms, getClient, type RoomSummary } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'

interface Props {
  auth: AuthState
  activeRoomId: string | null
  onSelectRoom: (roomId: string, roomName: string) => void
  onSignOut: () => void
  onReady: () => void
}

export default function RoomList({ auth, activeRoomId, onSelectRoom, onSignOut, onReady }: Props) {
  const cached = getCachedRooms(auth.userId)
  const [rooms, setRooms] = useState<RoomSummary[]>(cached ?? [])
  const [loading, setLoading] = useState(cached === null)
  const [error, setError] = useState('')
  const AVATARS_KEY = `construct:avatars:${auth.userId}`
  const cachedAvatars: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem(AVATARS_KEY) ?? '{}') } catch { return {} }
  })()
  const [roomAvatars, setRoomAvatars] = useState<Record<string, string>>(cachedAvatars)

  useEffect(() => {
    if (cached !== null) onReady()
    fetchJoinedRooms(auth)
      .then((r) => { setRooms(r); setLoading(false); if (cached === null) onReady() })
      .catch((e) => { setError(e.message); setLoading(false); if (cached === null) onReady() })
  }, [auth])

  // Resolve room avatars
  useEffect(() => {
    if (rooms.length === 0) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }
    const unresolved = rooms.filter(r => r.avatarMxc && !roomAvatars[r.roomId])
    if (unresolved.length === 0) return
    Promise.all(unresolved.map(async r => {
      const url = await resolveMediaUrl(client, r.avatarMxc!, 80, 80, 'crop')
      return { roomId: r.roomId, url }
    })).then(results => {
      const updates: Record<string, string> = {}
      results.forEach(r => { if (r.url) updates[r.roomId] = r.url })
      if (Object.keys(updates).length > 0) setRoomAvatars(prev => {
        const next = { ...prev, ...updates }
        try { localStorage.setItem(AVATARS_KEY, JSON.stringify(next)) } catch {}
        return next
      })
    })
  }, [rooms])

  // Keep room list live: re-sort and update unread on new messages
  useEffect(() => {
    if (loading) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }

    const onEvent = (_event: sdk.MatrixEvent, room: sdk.Room | undefined) => {
      if (!room) return
      setRooms((prev) => {
        const updated = prev.map((r) =>
          r.roomId === room.roomId
            ? {
                ...r,
                lastMessage: getLastMessage(room),
                lastTs: getLastTs(room),
                unreadCount: r.roomId === activeRoomId ? 0 : room.getUnreadNotificationCount(),
              }
            : r
        )
        return [...updated].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
      })
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => { client.off(sdk.RoomEvent.Timeline, onEvent) }
  }, [loading, activeRoomId])

  // Clear unread when active room changes
  useEffect(() => {
    if (!activeRoomId) return
    setRooms((prev) =>
      prev.map((r) => r.roomId === activeRoomId ? { ...r, unreadCount: 0 } : r)
    )
  }, [activeRoomId])

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
          <div className="room-grid">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton-card">
                <div className="skeleton-avatar" />
                <div className="skeleton-line narrow" />
              </div>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}

        <div className="room-grid">
          {rooms.map((room) => (
            <button
              key={room.roomId}
              className={`room-card${room.roomId === activeRoomId ? ' active' : ''}`}
              onClick={() => onSelectRoom(room.roomId, room.name)}
            >
              <div className="room-card-avatar">
                {roomAvatars[room.roomId]
                  ? <img src={roomAvatars[room.roomId]} alt="" />
                  : <span>{roomInitial(room.name)}</span>}
                {room.unreadCount > 0 && (
                  <span className="room-card-badge">
                    {room.unreadCount > 99 ? '99+' : room.unreadCount}
                  </span>
                )}
              </div>
              <div className="room-card-name">{room.name}</div>
            </button>
          ))}
        </div>
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

function getLastMessage(room: sdk.Room): string | undefined {
  const events = room.getLiveTimeline().getEvents()
  return [...events].reverse().find((e) => e.getType() === 'm.room.message')?.getContent()?.body
}

function getLastTs(room: sdk.Room): number | undefined {
  const events = room.getLiveTimeline().getEvents()
  return [...events].reverse().find((e) => e.getType() === 'm.room.message')?.getTs()
}

function roomInitial(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? '#'
}

function shortUserId(userId: string): string {
  return userId.replace(/^@/, '').split(':')[0]
}
