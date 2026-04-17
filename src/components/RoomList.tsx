import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { AuthState } from '../types'
import { fetchJoinedRooms, getClient, type RoomSummary } from '../lib/matrix'

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
      .then((r) => { setRooms(r); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [auth])

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
                <div className="room-name-row">
                  <div className="room-name">{room.name}</div>
                  {room.unreadCount > 0 && (
                    <span className="unread-badge">
                      {room.unreadCount > 99 ? '99+' : room.unreadCount}
                    </span>
                  )}
                </div>
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
