import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AuthState } from '../types'
import { fetchJoinedRooms, getCachedRooms, cacheRooms, getClient, getRoomOrder, setRoomOrder, applyRoomOrder, getRoomUnreadCount, isInvite, acceptInvite, toRoomSummary, toRoomSummaries, type RoomSummary } from '../lib/matrix'
import { useNavigate } from 'react-router-dom'
import { seedAgentPills } from '../lib/roomMeta'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { donateShareTargets, cacheRoomAvatars } from '../lib/liveActivity'
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
  // The live-update subscriptions below need the client to exist, which happens
  // asynchronously inside fetchJoinedRooms. `loading` can't stand in for that:
  // with a warm cache it starts false, so effects keyed on it ran once before
  // the client existed, bailed, and — since it never changed — never re-ran,
  // leaving the list with no sync/membership listeners for the whole session.
  const [clientReady, setClientReady] = useState(false)
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
        setClientReady(true)
        onReady()
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
        onReady()
        // A failed *initial sync* (e.g. timeout) still leaves a live client
        // behind, and the SDK keeps retrying — so attach the listeners anyway
        // and let the list correct itself once a sync lands.
        try { getClient(); setClientReady(true) } catch {}
      })
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

  // Cache every room's avatar for the Live Activity. Kept apart from the
  // share-target donation below, which is capped and filtered by the sharing
  // settings — a room excluded there still needs its picture on the lock screen.
  const avatarSigRef = useRef('')
  useEffect(() => {
    if (joinedRooms.length === 0) return
    const withAvatars = joinedRooms.filter(r => r.avatarMxc)
    const sig = withAvatars.map(r => `${r.roomId}:${r.avatarMxc}`).join('|')
    if (sig === avatarSigRef.current) return
    avatarSigRef.current = sig
    void cacheRoomAvatars(withAvatars.map(r => ({ roomId: r.roomId, avatarMxc: r.avatarMxc })))
  }, [joinedRooms])

  // Persist the live list so the next cold start paints what was last on screen
  // (invites included) instead of the previous launch's startup snapshot.
  useEffect(() => {
    if (!clientReady || rooms.length === 0) return
    cacheRooms(auth.userId, rooms)
  }, [rooms, clientReady, auth.userId])

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
  }, [rooms, clientReady])

  // Own profile picture (from homeserver; client is ready after room list fetch)
  useEffect(() => {
    if (!clientReady) return
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
  }, [auth.userId, clientReady])

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
    if (!clientReady) return
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
  }, [clientReady])

  // Update unread count when a push notification arrives for a room
  useEffect(() => {
    if (!clientReady) return
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
  }, [clientReady])

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
    if (!clientReady) return
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
  }, [clientReady, auth.userId])

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
                // Each probe reports on its own: this runs in two very different
                // environments (Safari/PWA and WKWebView, which has no Web Push
                // and no Matrix client until sync), and one missing API used to
                // throw away the whole report.
                const line = async (label: string, probe: () => Promise<string>) => {
                  try { return `${label}: ${await probe()}` } catch (e: any) { return `${label}: error — ${e?.message}` }
                }
                const report = [
                  `Origin: ${location.origin}`,
                  // Whether the offline shell is in place. In WKWebView a
                  // service worker only runs on app-bound domains, so this is
                  // the quickest way to tell a native build can cold-start offline.
                  await line('Service worker', async () => {
                    if (!('serviceWorker' in navigator)) return 'unsupported (no offline shell)'
                    const reg = await navigator.serviceWorker.getRegistration()
                    if (!reg) return 'not registered'
                    const state = reg.active ? 'active' : reg.installing ? 'installing' : 'registered'
                    return `${state} @ ${reg.scope}`
                  }),
                  await line('Shell cache', async () => {
                    if (!('caches' in window)) return 'unsupported'
                    const keys = await (await caches.open('construct-shell-v1')).keys()
                    return keys.length ? `${keys.length} entries` : 'empty'
                  }),
                  // Absent in WKWebView — the native app is pushed via APNs.
                  await line('Push subscription', async () => {
                    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
                    if (!reg?.pushManager) return 'n/a (native push)'
                    const sub = await reg.pushManager.getSubscription()
                    return sub?.endpoint ? `...${sub.endpoint.slice(-20)}` : 'none'
                  }),
                  // This feature works by making notifications *not* happen, so
                  // when it misfires there's nothing to see. Listing who is
                  // holding the phone quiet is the whole diagnosis.
                  await line('Foreground clients', async () => {
                    const secret = import.meta.env.VITE_INTENT_SECRET
                    if (!secret) return 'n/a (no intent secret in this build)'
                    const r = await fetch('/api/live-activity', { headers: { 'x-intent-secret': secret } })
                    const clients = (await r.json())?.activeClients ?? []
                    if (!clients.length) return 'none — notifications flow normally'
                    return '\n' + clients.map((c: { client: string; viewingRoom: string | null; ageMs: number }) =>
                      `  ${c.client}${c.viewingRoom ? ` in ${c.viewingRoom.slice(0, 12)}…` : ''} (${Math.round(c.ageMs / 1000)}s ago)`
                    ).join('\n')
                  }),
                  await line('Registered pushers', async () => {
                    const pushers = await getClient().getPushers()
                    return '\n' + ((pushers?.pushers ?? []).map((p: any) =>
                      `  ${p.app_display_name} / ${p.device_display_name}: ...${String(p.pushkey).slice(-20)}`
                    ).join('\n') || '  none')
                  }),
                ]
                alert(report.join('\n'))
              }}>
                Debug notifications
              </button>
              <button className="user-menu-item" onClick={() => navigate('/settings')}>
                Settings
              </button>
              {/* The web app is served over the network (see capacitor.config.ts),
                  so this picks up a deploy without reinstalling: the reload is a
                  navigation, and the service worker fetches those network-first.
                  Refresh the worker itself first — otherwise a changed sw.js is
                  only noticed on the browser's own schedule, leaving the caching
                  rules a deploy behind. */}
              <button className="user-menu-item" onClick={async () => {
                try {
                  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
                  await reg?.update()
                } catch { /* not fatal — reload anyway */ }
                window.location.reload()
              }}>
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
