import { memo, useEffect, useRef, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AuthState } from '../types'
import { fetchJoinedRooms, getCachedRooms, getClient, getRoomOrder, setRoomOrder, applyRoomOrder, type RoomSummary } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'

interface Props {
  auth: AuthState
  activeRoomId: string | null
  onSelectRoom: (roomId: string, roomName: string) => void
  onSignOut: () => void
  onReady: () => void
}

const SortableRoomCard = memo(function SortableRoomCard({ room, isActive, avatar, onSelect }: {
  room: RoomSummary
  isActive: boolean
  avatar?: string
  onSelect: (roomId: string, name: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: room.roomId })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }
  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={`room-card${isActive ? ' active' : ''}`}
      onClick={() => onSelect(room.roomId, room.name)}
    >
      {/* touch-action:none only on the avatar so the drag sensor can
          capture touch events there, while the card name area still
          allows the list to scroll naturally */}
      <div className="room-card-avatar" {...listeners}>
        {avatar ? <img src={avatar} alt="" /> : <span>{roomInitial(room.name)}</span>}
        {room.unreadCount > 0 && (
          <span className="room-card-badge">
            {room.unreadCount > 99 ? '99+' : room.unreadCount}
          </span>
        )}
      </div>
      <div className="room-card-name">{room.name}</div>
    </button>
  )
})

export default function RoomList({ auth, activeRoomId, onSelectRoom, onSignOut, onReady }: Props) {
  const cached = getCachedRooms(auth.userId)
  const savedOrder = getRoomOrder(auth.userId)
  const initialRooms = cached ? (savedOrder ? applyRoomOrder(cached, savedOrder) : cached) : []
  const [rooms, setRooms] = useState<RoomSummary[]>(initialRooms)
  const [loading, setLoading] = useState(cached === null)
  const [error, setError] = useState('')
  const [roomAvatars, setRoomAvatars] = useState<Record<string, string>>({})
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  useEffect(() => {
    fetchJoinedRooms(auth)
      .then((r) => {
        const order = getRoomOrder(auth.userId)
        setRooms(order ? applyRoomOrder(r, order) : r)
        setLoading(false)
        onReady()
      })
      .catch((e) => { setError(e.message); setLoading(false); onReady() })
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
      if (Object.keys(updates).length > 0) setRoomAvatars(prev => ({ ...prev, ...updates }))
    })
  }, [rooms])

  // Own profile picture (from homeserver; client is ready after room list fetch)
  useEffect(() => {
    if (loading) return
    let cancelled = false
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }
    void (async () => {
      try {
        const info = (await client.getProfileInfo(
          auth.userId,
        )) as { avatar_url?: string }
        const mxc = info?.avatar_url
        if (!mxc || cancelled) {
          if (!cancelled) setUserAvatarUrl(null)
          return
        }
        const url = await resolveMediaUrl(client, mxc, 64, 64, 'crop')
        if (cancelled) return
        setUserAvatarUrl(url ?? null)
      } catch {
        if (!cancelled) setUserAvatarUrl(null)
      }
    })()
    return () => { cancelled = true }
  }, [auth.userId, loading])

  // Keep active room in a ref so the timeline subscription below doesn't
  // tear down and re-subscribe every time the active room changes.
  useEffect(() => {
    if (!profileOpen) return
    function onClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [profileOpen])

  const activeRoomIdRef = useRef(activeRoomId)
  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  // Update unread counts on new messages (no reorder)
  useEffect(() => {
    if (loading) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }

    const onEvent = (event: sdk.MatrixEvent, room: sdk.Room | undefined) => {
      if (!room) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return
      const newCount = room.roomId === activeRoomIdRef.current ? 0 : room.getUnreadNotificationCount()
      setRooms((prev) => {
        let changed = false
        const next = prev.map((r) => {
          if (r.roomId !== room.roomId) return r
          if (r.unreadCount === newCount) return r
          changed = true
          return { ...r, unreadCount: newCount }
        })
        return changed ? next : prev
      })
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => { client.off(sdk.RoomEvent.Timeline, onEvent) }
  }, [loading])

  // Clear unread when active room changes
  useEffect(() => {
    if (!activeRoomId) return
    setRooms((prev) => {
      let changed = false
      const next = prev.map((r) => {
        if (r.roomId !== activeRoomId || r.unreadCount === 0) return r
        changed = true
        return { ...r, unreadCount: 0 }
      })
      return changed ? next : prev
    })
  }, [activeRoomId])

  function handleDragEnd(event: { active: { id: string | number }, over: { id: string | number } | null }) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setRooms((prev) => {
      const oldIndex = prev.findIndex(r => r.roomId === active.id)
      const newIndex = prev.findIndex(r => r.roomId === over.id)
      const next = arrayMove(prev, oldIndex, newIndex)
      setRoomOrder(auth.userId, next.map(r => r.roomId))
      return next
    })
  }

  return (
    <div className="room-list">

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

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rooms.map(r => r.roomId)} strategy={rectSortingStrategy}>
            <div className="room-grid">
              {rooms.map((room) => (
                <SortableRoomCard
                  key={room.roomId}
                  room={room}
                  isActive={room.roomId === activeRoomId}
                  avatar={roomAvatars[room.roomId]}
                  onSelect={onSelectRoom}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      <div className="sidebar-footer">
        <div className="user-badge-wrap" ref={profileRef}>
          {profileOpen && (
            <div className="user-menu">
              <button className="user-menu-item user-menu-item--danger" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          )}
          <button className="user-badge" onClick={() => setProfileOpen(p => !p)}>
            <div className="user-avatar">
              {userAvatarUrl
                ? <img src={userAvatarUrl} alt="" />
                : (auth.userId[1]?.toUpperCase() ?? '?')}
            </div>
            <div className="user-id">{shortUserId(auth.userId)}</div>
          </button>
        </div>
      </div>
    </div>
  )
}


function roomInitial(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? '#'
}

function shortUserId(userId: string): string {
  return userId.replace(/^@/, '').split(':')[0]
}
