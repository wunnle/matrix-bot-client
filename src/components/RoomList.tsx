import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AuthState } from '../types'
import { fetchJoinedRooms, getCachedRooms, getClient, getRoomOrder, setRoomOrder, applyRoomOrder, getRoomUnreadCount, isInvite, acceptInvite, toRoomSummary, toRoomSummaries, type RoomSummary } from '../lib/matrix'
import { useNavigate } from 'react-router-dom'
import { seedAgentPills } from '../lib/roomMeta'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { donateShareTargets } from '../lib/liveActivity'
import { getDisabledShareRooms } from '../lib/shareRooms'
import NotificationCenter from './NotificationCenter'
import { toggleDebug } from '../lib/debug'
import type { RoomNotification } from '../hooks/useRoomNotifications'

interface Props {
  auth: AuthState
  activeRoomId: string | null
  onSelectRoom: (roomId: string, roomName: string) => void
  onSignOut: () => void
  onReady: () => void
  dictationAutoSend: boolean
  onDictationAutoSendChange: (value: boolean) => void
  notifications: RoomNotification[]
  onDismissNotification: (roomId: string) => void
}

const SortableRoomCard = memo(function SortableRoomCard({ room, isActive, avatar, hasNotification, onSelect }: {
  room: RoomSummary
  isActive: boolean
  avatar?: string
  hasNotification: boolean
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
        {(room.unreadCount > 0 || hasNotification) && (
          <span className="room-card-badge">
            {room.unreadCount > 99 ? '99+' : Math.max(room.unreadCount, 1)}
          </span>
        )}
      </div>
      <div className="room-card-name">{room.name}</div>
    </button>
  )
})

// An invite renders as a faded version of the room tile it will become.
// Tapping accepts and opens it — the two-button card was a second visual
// language for what is really just "a room you have not opened yet".
const InviteTile = memo(function InviteTile({ room, busy, onAccept }: {
  room: RoomSummary
  busy: boolean
  onAccept: (roomId: string, name: string) => void
}) {
  return (
    <button
      className="room-card room-card--invite"
      onClick={() => onAccept(room.roomId, room.name)}
      disabled={busy}
      title={room.invitedBy ? `Invite from ${shortUserId(room.invitedBy)}` : 'Invitation'}
    >
      <div className="room-card-avatar">
        {busy ? <span>…</span> : <span>{roomInitial(room.name)}</span>}
      </div>
      <div className="room-card-name">{room.name}</div>
    </button>
  )
})

export default function RoomList({
  auth,
  activeRoomId,
  onSelectRoom,
  onSignOut,
  onReady,
  dictationAutoSend,
  onDictationAutoSendChange,
  notifications,
  onDismissNotification,
}: Props) {
  const cached = getCachedRooms(auth.userId)
  const savedOrder = getRoomOrder(auth.userId)
  const initialRooms = cached ? (savedOrder ? applyRoomOrder(cached, savedOrder) : cached) : []
  const [rooms, setRooms] = useState<RoomSummary[]>(initialRooms)
  const [loading, setLoading] = useState(cached === null)
  const [error, setError] = useState('')
  const [roomAvatars, setRoomAvatars] = useState<Record<string, string>>({})
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null)
  const profileRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const [invitesBusy, setInvitesBusy] = useState<Record<string, boolean>>({})
  const [inviteError, setInviteError] = useState('')

  const invites = useMemo(() => rooms.filter(isInvite), [rooms])
  const joinedRooms = useMemo(() => rooms.filter((r) => !isInvite(r)), [rooms])

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

  // Donate rooms as share-sheet direct-share targets (native iOS only), minus
  // any the user turned off in Settings. Only re-donate when the enabled set or
  // their names change — `rooms` also updates on every unread/timestamp change,
  // and re-donating each time hitches.
  const donatedSigRef = useRef('')
  useEffect(() => {
    if (joinedRooms.length === 0) return
    const disabled = getDisabledShareRooms(auth.userId)
    // Invites are excluded: you cannot send to a room you have not joined.
    const enabled = joinedRooms.filter(r => !disabled.has(r.roomId))
    const sig = enabled.map(r => `${r.roomId}:${r.name}`).join('|')
    if (sig === donatedSigRef.current) return
    donatedSigRef.current = sig
    void donateShareTargets(
      enabled.map(r => ({ roomId: r.roomId, name: r.name, avatarMxc: r.avatarMxc })),
      [...disabled],
    )
  }, [joinedRooms, auth.userId])

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
      if (Object.keys(updates).length > 0) {
        setRoomAvatars(prev => ({ ...prev, ...updates }))
        const existing = JSON.parse(localStorage.getItem('room_avatars') || '{}')
        localStorage.setItem('room_avatars', JSON.stringify({ ...existing, ...updates }))
      }
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

  // Read master push rule state when menu opens
  useEffect(() => {
    if (!profileOpen) return
    let cancelled = false;
    (async () => {
      try {
        const client = getClient()
        const rules = await client.getPushRules()
        if (cancelled) return
        const master = rules?.global?.override?.find(
          (r: sdk.IPushRule) => r.rule_id === '.m.rule.master'
        )
        setNotificationsEnabled(master ? !master.enabled : true)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [profileOpen])

  const toggleNotifications = async () => {
    try {
      const client = getClient()
      const next = !notificationsEnabled
      await client.setPushRuleEnabled('global', sdk.PushRuleKind.Override, '.m.rule.master', !next)
      setNotificationsEnabled(next)
    } catch {}
  }

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
      const newCount = room.roomId === activeRoomIdRef.current ? 0 : getRoomUnreadCount(room, auth.userId)
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

    const onReceipt = (_event: sdk.MatrixEvent, room: sdk.Room) => {
      const newCount = room.roomId === activeRoomIdRef.current ? 0 : getRoomUnreadCount(room, auth.userId)
      setRooms((prev) => {
        let changed = false
        const next = prev.map((r) => {
          if (r.roomId !== room.roomId || r.unreadCount === newCount) return r
          changed = true
          return { ...r, unreadCount: newCount }
        })
        return changed ? next : prev
      })
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    client.on(sdk.RoomEvent.Receipt, onReceipt)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onEvent)
      client.off(sdk.RoomEvent.Receipt, onReceipt)
    }
  }, [loading])

  // Update unread count when a push notification arrives for a room
  useEffect(() => {
    if (loading) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }

    const onPush = (e: Event) => {
      const { roomId } = (e as CustomEvent<{ roomId: string }>).detail
      if (roomId === activeRoomIdRef.current) return
      const room = client.getRoom(roomId)
      if (!room) return
      const newCount = getRoomUnreadCount(room, auth.userId)
      setRooms((prev) => {
        let changed = false
        const next = prev.map((r) => {
          if (r.roomId !== roomId || r.unreadCount === newCount) return r
          changed = true
          return { ...r, unreadCount: newCount }
        })
        return changed ? next : prev
      })
    }

    window.addEventListener("matrix-push", onPush)
    return () => window.removeEventListener("matrix-push", onPush)
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

  // Keep the list in step with invites arriving, being accepted, or being
  // revoked while the app is open.
  useEffect(() => {
    if (loading) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }

    const onMembership = (room: sdk.Room, membership: string) => {
      setRooms((prev) => {
        const without = prev.filter((r) => r.roomId !== room.roomId)
        if (membership !== 'join' && membership !== 'invite') return without
        // Anything new — joined or invited — appends, so it never displaces
        // rooms the user has already arranged.
        return [...without, toRoomSummary(room, auth.userId)]
      })
    }

    // MyMembership only reaches a listener that happens to be mounted when the
    // event lands. Recomputing on each sync makes the list self-correcting,
    // rather than depending on catching that one event.
    const onSync = (state: string) => {
      if (state !== 'SYNCING') return
      const fresh = toRoomSummaries(client, auth.userId)
      setRooms((prev) => {
        const changed = fresh.length !== prev.length
          || fresh.some((r, i) => r.roomId !== prev[i]?.roomId || r.membership !== prev[i]?.membership)
        if (!changed) return prev
        // Keep every room already on screen exactly where it is; anything
        // new lands at the end. Re-deriving from saved order here would
        // reshuffle rooms that have no saved position.
        const seen = new Map(prev.map((r, i) => [r.roomId, i]))
        return [...fresh].sort((a, b) => {
          const ai = seen.get(a.roomId) ?? Infinity
          const bi = seen.get(b.roomId) ?? Infinity
          return ai - bi
        })
      })
    }

    client.on(sdk.RoomEvent.MyMembership, onMembership)
    client.on(sdk.ClientEvent.Sync, onSync)
    return () => {
      client.off(sdk.RoomEvent.MyMembership, onMembership)
      client.off(sdk.ClientEvent.Sync, onSync)
    }
  }, [loading, auth.userId])

  async function handleAcceptInvite(roomId: string, name: string) {
    setInviteError('')
    setInvitesBusy((p) => ({ ...p, [roomId]: true }))
    try {
      await acceptInvite(roomId)
      // Agent rooms ship with a standard command set. Seeded here rather than
      // by the bot, which cannot write pills — they live in this user's account
      // data. Non-fatal: a failure here should not block opening the room.
      await seedAgentPills(getClient(), roomId).catch(() => {})
      // Promote it locally rather than waiting for MyMembership: opening the
      // room unmounts this list, so the event can land with no listener
      // attached and the card would still read "invite" on the way back.
      setRooms((prev) => prev.map((r) => (
        r.roomId === roomId ? { ...r, membership: 'join' as const, invitedBy: undefined } : r
      )))
      onSelectRoom(roomId, name)
    } catch (e) {
      setInviteError((e as Error).message ?? 'Could not join room')
    } finally {
      setInvitesBusy((p) => ({ ...p, [roomId]: false }))
    }
  }

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

        {inviteError && <p className="error">{inviteError}</p>}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={joinedRooms.map(r => r.roomId)} strategy={rectSortingStrategy}>
            <div className="room-grid">
              {joinedRooms.map((room) => (
                <SortableRoomCard
                  key={room.roomId}
                  room={room}
                  isActive={room.roomId === activeRoomId}
                  avatar={roomAvatars[room.roomId]}
                  hasNotification={notifications.some(n => n.roomId === room.roomId)}
                  onSelect={onSelectRoom}
                />
              ))}
              {/* Invites sit after the joined rooms: a room you have not opened
                  yet should never displace one you use. */}
              {invites.map((room) => (
                <InviteTile
                  key={room.roomId}
                  room={room}
                  busy={invitesBusy[room.roomId] ?? false}
                  onAccept={handleAcceptInvite}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <NotificationCenter
          notifications={notifications}
          onDismiss={onDismissNotification}
          onNavigate={onSelectRoom}
        />
      </div>

      <div className="sidebar-footer">
        <div className="user-badge-wrap" ref={profileRef}>
          {profileOpen && (
            <div className="user-menu">
              <label
                className="user-menu-toggle-row"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <span className="user-menu-toggle-label">Auto-send when done talking</span>
                <input
                  type="checkbox"
                  className="user-menu-toggle-input"
                  checked={dictationAutoSend}
                  onChange={(e) => onDictationAutoSendChange(e.target.checked)}
                  aria-label="Auto-send when done talking"
                />
              </label>
              <label
                className="user-menu-toggle-row"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <span className="user-menu-toggle-label">Notifications</span>
                <input
                  type="checkbox"
                  className="user-menu-toggle-input"
                  checked={notificationsEnabled ?? false}
                  disabled={notificationsEnabled === null}
                  onChange={toggleNotifications}
                  aria-label="Notifications"
                />
              </label>
              <button className="user-menu-item" onClick={async () => {
                try {
                  const client = getClient()
                  const pushers = await client.getPushers()
                  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
                  const sub = reg ? await reg.pushManager.getSubscription() : null
                  const subEndpoint = sub?.endpoint?.slice(-20) ?? 'none'
                  const pusherList = (pushers?.pushers ?? []).map((p: any) =>
                    `${p.app_display_name} / ${p.device_display_name}: ...${String(p.pushkey).slice(-20)}`
                  ).join('\n') || 'none'
                  alert(`Push subscription: ...${subEndpoint}\n\nRegistered pushers:\n${pusherList}`)
                } catch (e: any) {
                  alert(`Debug error: ${e?.message}`)
                }
              }}>
                Debug notifications
              </button>
              <button className="user-menu-item" onClick={() => navigate('/settings')}>
                Settings
              </button>
              <button className="user-menu-item" onClick={() => window.location.reload()}>
                Reload app
              </button>
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
        <div className="sidebar-version" onClick={toggleDebug}>v{__CONSTRUCT_VERSION__}</div>
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
