import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AuthState } from '../types'
import { fetchJoinedRooms, getCachedRooms, cacheRooms, getClient, getRoomOrder, getRemoteRoomOrder, setRoomOrder, cacheRoomOrder, applyRoomOrder, ROOM_ORDER_EVENT, getRoomUnreadCount, isInvite, acceptInvite, toRoomSummary, toRoomSummaries, type RoomSummary } from '../lib/matrix'
import { seedAgentPills, backfillAgentPills } from '../lib/roomMeta'
import { findSpawnHostRoom, spawnAgentRoom } from '../lib/spawnAgent'
import { createSpawnGate, type AgentProvider } from '../lib/spawnCommand'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { donateShareTargets, cacheRoomAvatars } from '../lib/liveActivity'
import { getDisabledShareRooms, isShareableRoom } from '../lib/shareRooms'
import NotificationCenter from './NotificationCenter'
import { hapticPress } from '../lib/haptics'
import { useRoomAgentStates } from '../hooks/useRoomAgentStates'
import type { RoomAgentState } from '../lib/roomAgentState'
import type { RoomNotification } from '../hooks/useRoomNotifications'

interface Props {
  auth: AuthState
  activeRoomId: string | null
  onSelectRoom: (roomId: string, roomName: string) => void
  onReady: () => void
  notifications: RoomNotification[]
  onDismissNotification: (roomId: string) => void
}

const SortableRoomCard = memo(function SortableRoomCard({ room, isActive, avatar, hasNotification, agent, onSelect }: {
  room: RoomSummary
  isActive: boolean
  avatar?: string
  hasNotification: boolean
  agent?: RoomAgentState
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
      aria-description={
        (agent && agentStatusLabel(agent)) ?? (room.unreadCount > 0 || hasNotification ? 'Unread' : undefined)
      }
    >
      {/* touch-action:none only on the avatar so the drag sensor can
          capture touch events there, while the card name area still
          allows the list to scroll naturally */}
      <div className="room-card-avatar" {...listeners}>
        {avatar ? <img src={avatar} alt="" /> : <span>{roomInitial(room.name)}</span>}
        <RoomCardBadge agent={agent} unread={room.unreadCount > 0 || hasNotification} />
      </div>
      <div className="room-card-name">{room.name}</div>
    </button>
  )
})

// One iOS-style badge per tile, showing only what matters most: the agent is
// waiting on you, else it's working, else there's something unread. The count
// never mattered — a dot says "go look" just as well.
const AGENT_BADGE_ICON: Record<Exclude<RoomAgentState['kind'], 'idle' | 'working'>, string> = {
  approval: 'lock',
  question: 'question_mark',
  blocked: 'hourglass_top',
}

function RoomCardBadge({ agent, unread }: { agent?: RoomAgentState; unread: boolean }) {
  if (agent?.kind === 'working') {
    // Drawn, not a glyph: a spinning font glyph wobbles off-centre by however
    // far the font's metrics put it from the middle of its box.
    return (
      <span className="room-card-badge room-card-badge--working" aria-hidden>
        <span className="room-card-badge-spinner" />
      </span>
    )
  }
  if (agent && agent.kind !== 'idle') {
    return (
      <span className={`room-card-badge room-card-badge--${agent.kind}`} aria-hidden>
        <span className="material-symbols-outlined">{AGENT_BADGE_ICON[agent.kind]}</span>
      </span>
    )
  }
  if (unread) return <span className="room-card-badge room-card-badge--unread" aria-hidden />
  return null
}

function agentStatusLabel(agent: RoomAgentState): string | undefined {
  switch (agent.kind) {
    case 'approval': return 'Needs approval'
    case 'question': return 'Has a question'
    case 'blocked': return 'Usage limit'
    case 'working': return `${agent.label}…`
    case 'idle': return undefined
  }
}

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

// The ghost tile that spawns a new agent room. Deliberately shaped like the
// invite tile: what it produces *is* an invite, and it sits in the same place
// the new room's own tile will appear a moment later.
const SpawnTile = memo(function SpawnTile({ provider, busy, disabled, onSpawn }: {
  provider: AgentProvider
  busy: boolean
  disabled: boolean
  onSpawn: (provider: AgentProvider) => void
}) {
  const label = provider === 'codex' ? 'codexbot' : 'claudebot'
  return (
    <button
      className="room-card room-card--spawn"
      onClick={() => onSpawn(provider)}
      disabled={disabled}
      title={`Start a new ${provider === 'codex' ? 'Codex' : 'Claude Code'} agent room`}
    >
      <div className="room-card-avatar">
        <span>{busy ? '…' : '+'}</span>
      </div>
      <div className="room-card-name">{busy ? 'spawning…' : `new ${label}`}</div>
    </button>
  )
})

export default function RoomList({
  auth,
  activeRoomId,
  onSelectRoom,
  onReady,
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
  const [invitesBusy, setInvitesBusy] = useState<Record<string, boolean>>({})
  const [inviteError, setInviteError] = useState('')
  const [spawning, setSpawning] = useState<AgentProvider | null>(null)
  const spawnGate = useRef(createSpawnGate())

  const invites = useMemo(() => rooms.filter(isInvite), [rooms])
  const joinedRooms = useMemo(() => rooms.filter((r) => !isInvite(r)), [rooms])
  const joinedRoomIds = useMemo(() => joinedRooms.map((r) => r.roomId), [joinedRooms])
  const agentStates = useRoomAgentStates(clientReady, joinedRoomIds, auth.userId)

  // Only offered when there is somewhere to send `!spawn` — the command needs a
  // room the bot is already in, and a dead button is worse than no button.
  // Derived on each render rather than memoised: the answer lives in the SDK's
  // room state, which `rooms` does not mirror, so there is no dependency list
  // that would keep a cached value honest.
  let canSpawn = false
  if (clientReady) {
    try { canSpawn = findSpawnHostRoom(getClient()) !== null } catch { /* no client yet */ }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  useEffect(() => {
    fetchJoinedRooms(auth)
      .then((r) => {
        // Account data wins over the localStorage mirror: it is what another
        // device may have reordered since this one last ran.
        let order: string[] | null = null
        try { order = getRemoteRoomOrder(getClient()) } catch { /* fall back to the mirror */ }
        if (order) {
          cacheRoomOrder(auth.userId, order)
        } else {
          // Nothing on the server yet — migrate whatever this device already
          // had up, so an order set before this change follows the account.
          order = getRoomOrder(auth.userId)
          if (order) setRoomOrder(auth.userId, order)
        }
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
  // One pill backfill per app start; the recorded migration handles the rest.
  const backfilledRef = useRef(false)
  useEffect(() => {
    if (joinedRooms.length === 0) return
    const disabled = getDisabledShareRooms(auth.userId)
    // Invites are excluded: you cannot send to a room you have not joined.
    // Agent rooms are excluded too, and not as a default — see isShareableRoom.
    const agentRooms = joinedRooms.filter(r => !isShareableRoom(r.roomId)).map(r => r.roomId)
    const enabled = joinedRooms.filter(r => !disabled.has(r.roomId) && isShareableRoom(r.roomId))
    const sig = enabled.map(r => `${r.roomId}:${r.name}`).join('|')
    if (sig === donatedSigRef.current) return
    donatedSigRef.current = sig
    void donateShareTargets(
      enabled.map(r => ({ roomId: r.roomId, name: r.name, avatarMxc: r.avatarMxc })),
      // Dropping a room from the donated set does not retract it: `remove` is an
      // explicit list. Agent rooms donated before this rule existed would stay
      // in the share sheet forever without being named here.
      [...disabled, ...agentRooms],
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

  // Keep active room in a ref so the timeline subscription below doesn't
  // tear down and re-subscribe every time the active room changes.
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

  // Home-screen / dock icon count, kept current while the app is open; the
  // service worker sets it on each push. Rooms with unread, not messages — the
  // homeserver's `unread` it gets on a push counts rooms, so the two agree.
  // Feature-detected: absent in the native app's WebView, where APNs owns it.
  useEffect(() => {
    if (loading || !('setAppBadge' in navigator)) return
    const n = rooms.filter((r) => r.unreadCount > 0).length
    void (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {})
  }, [rooms, loading])

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
      // A default pill added after a room was accepted never reaches it, since
      // seeding only happens on accept. Top those rooms up here — guarded so it
      // runs once per app start, and a no-op after the migration is recorded.
      if (!backfilledRef.current) {
        backfilledRef.current = true
        backfillAgentPills(client).catch(() => {})
      }
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

    // Reorder done on another device arrives as account data — apply it live.
    const onAccountData = (event: sdk.MatrixEvent) => {
      if (event.getType() !== ROOM_ORDER_EVENT) return
      const order = getRemoteRoomOrder(client)
      if (!order) return
      cacheRoomOrder(auth.userId, order)
      setRooms((prev) => applyRoomOrder(prev, order))
    }

    client.on(sdk.RoomEvent.MyMembership, onMembership)
    client.on(sdk.ClientEvent.Sync, onSync)
    client.on(sdk.ClientEvent.AccountData, onAccountData)
    return () => {
      client.off(sdk.RoomEvent.MyMembership, onMembership)
      client.off(sdk.ClientEvent.Sync, onSync)
      client.off(sdk.ClientEvent.AccountData, onAccountData)
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

  async function handleSpawn(provider: AgentProvider) {
    if (!spawnGate.current.begin()) return
    setInviteError('')
    setSpawning(provider)
    try {
      const client = getClient()
      const host = findSpawnHostRoom(client)
      if (!host) {
        setInviteError('No room to spawn from — open an agent room first.')
        return
      }
      const roomId = await spawnAgentRoom(client, host, provider)
      // The invite's own name is what the bot chose (Bender-N); accepting here
      // rather than leaving the ghost invite tile behind is the whole point of
      // the button — one tap, one room.
      const name = client.getRoom(roomId)?.name ?? 'agent'
      await handleAcceptInvite(roomId, name)
    } catch (e) {
      setInviteError((e as Error).message ?? 'Could not spawn a room')
    } finally {
      spawnGate.current.end()
      setSpawning(null)
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

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={hapticPress} onDragEnd={handleDragEnd}>
          <SortableContext items={joinedRooms.map(r => r.roomId)} strategy={rectSortingStrategy}>
            <div className="room-grid">
              {joinedRooms.map((room) => (
                <SortableRoomCard
                  key={room.roomId}
                  room={room}
                  isActive={room.roomId === activeRoomId}
                  avatar={roomAvatars[room.roomId]}
                  hasNotification={notifications.some(n => n.roomId === room.roomId)}
                  agent={agentStates[room.roomId]}
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
              {/* Last tiles in the grid: they create rooms rather than opening
                  one, so they should never sit above rooms that exist. */}
              {canSpawn && (
                <>
                  <SpawnTile
                    provider="claude"
                    busy={spawning === 'claude'}
                    disabled={spawning !== null}
                    onSpawn={handleSpawn}
                  />
                  <SpawnTile
                    provider="codex"
                    busy={spawning === 'codex'}
                    disabled={spawning !== null}
                    onSpawn={handleSpawn}
                  />
                </>
              )}
            </div>
          </SortableContext>
        </DndContext>
        <NotificationCenter
          notifications={notifications}
          onDismiss={onDismissNotification}
          onNavigate={onSelectRoom}
        />
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
