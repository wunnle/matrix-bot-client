import React from 'react'
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from 'react'
import * as sdk from 'matrix-js-sdk'
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useSearchParams } from 'react-router-dom'
import { getClient } from '../lib/matrix'
import { pinRoomEvent, unpinRoomEvent } from '../lib/pinRoomMessage'
import { loadPills, savePills } from '../lib/roomMeta'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { Capacitor } from '@capacitor/core'
import { isMobileSafari } from '../lib/isMobileSafari'
import { startAwaitingReply, maybeShowReply, startListening, updateListeningTranscript, stopListening, awaitingReply } from '../lib/liveActivity'
import { useSpeechDictation } from '../hooks/useSpeechDictation'
import { useToast } from '../hooks/useToast'
import { useVisualViewportResize } from '../hooks/useVisualViewport'
import RoomEditor from './RoomEditor'
import { marked } from 'marked'
import type { Message, RoomConfig, ConstructThread, ToolProgressLine } from '../types'

interface Props {
  roomId: string
  isActive: boolean
  roomName: string
  config?: RoomConfig
  userId: string
  onBack: () => void
  /** Global: when true, mic dictation auto-sends after long silence (see user menu). */
  dictationAutoSend: boolean
}

const PAGE_SIZE = 30
const RENDER_LIMIT = 60 // kept for isActive reset logic only
const MSG_CAP = 200 // max messages kept in state; old ones dropped from the front
const PIN_LONG_PRESS_MS = 500
const PIN_MOVE_CANCEL_PX = 10
const MENU_DISMISS_GRACE_MS = 350

// Our swipe-back gesture is only useful where nothing else owns the edge
// swipe. In a regular browser (iOS Safari, most Android browsers) the
// OS/browser already provides an edge-swipe-back whose animation fights
// ours and makes the transition feel glitchy. Enable it in the native app
// (Capacitor WKWebView has no back gesture of its own) and in an installed
// PWA. Detect once at module load.
const enableSwipeBack =
  typeof window !== 'undefined' &&
  (Capacitor.isNativePlatform() ||
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS-specific standalone flag (non-standard, still used)
    (navigator as unknown as { standalone?: boolean }).standalone === true)


function isToolProgressMessage(_body: string, msg?: Message): boolean {
  return !!msg?.toolProgress
}

function parseToolProgressMessage(_body: string, msg?: Message): ToolProgressLine[] {
  return msg?.toolProgress ?? []
}

function summarizeToolLines(lines: ToolProgressLine[]): string {
  const known: Record<string, number> = {}
  const byName: Record<string, number> = {}
  for (const l of lines) {
    const t = l.tool.toLowerCase()
    const n = l.repeat ?? 1
    const cat =
      t === 'bash' || t === 'terminal' ? 'commands' :
      t === 'edit' || t === 'write' || t === 'patch' ? 'edited' :
      t === 'read' || t === 'read_file' ? 'read' :
      t === 'grep' || t === 'glob' || t === 'search_files' || t === 'search' ? 'searches' :
      t === 'agent' ? 'agents' :
      t === 'skill_view' ? 'skills' :
      null
    if (cat) {
      known[cat] = (known[cat] ?? 0) + n
    } else {
      byName[l.tool] = (byName[l.tool] ?? 0) + n
    }
  }
  const parts: string[] = []
  if (known['commands']) { const v = known['commands']; parts.push(`Ran ${v} command${v === 1 ? '' : 's'}`) }
  if (known['edited']) { const v = known['edited']; parts.push(`edited ${v} file${v === 1 ? '' : 's'}`) }
  if (known['read']) { const v = known['read']; parts.push(`read ${v} file${v === 1 ? '' : 's'}`) }
  if (known['searches']) { const v = known['searches']; parts.push(`${v} search${v === 1 ? '' : 'es'}`) }
  if (known['agents']) { const v = known['agents']; parts.push(`${v} agent${v === 1 ? '' : 's'}`) }
  if (known['skills']) { const v = known['skills']; parts.push(`${v} skill${v === 1 ? '' : 's'}`) }
  for (const [name, v] of Object.entries(byName)) parts.push(`${v}× ${name}`)
  return parts.join(', ') || 'Used tools'
}

// Doc examples like [[label]] or <code>[[button]]</code> — not real CTAs
function isActionPlaceholder(inner: string): boolean {
  const t = inner.trim().toLowerCase()
  return t === 'label' || t === 'button'
}

function parseActions(body: string): { text: string; actions: string[] } {
  const actions: string[] = []
  const text = body.replace(/\[\[([^\]]{1,40})\]\]/g, (match, label) => {
    if (isActionPlaceholder(label)) return match
    actions.push(label.trim())
    return ''
  }).trim()
  return { text, actions }
}

const CODE_BLOCK = /<code(\s[^>]*)?>[\s\S]*?<\/code>/gi

/** Remove [[CTA]] from non-code HTML only; keep all [[...]] inside <code> (docs). */
function stripActionMarkersInRichHtml(html: string): string {
  const out: string[] = []
  let i = 0
  CODE_BLOCK.lastIndex = 0
  for (;;) {
    const m = CODE_BLOCK.exec(html)
    if (!m) {
      out.push(stripActionMarkersInPlainTextSegment(html.slice(i)))
      break
    }
    out.push(stripActionMarkersInPlainTextSegment(html.slice(i, m.index)))
    out.push(m[0])
    i = m.index + m[0].length
  }
  return out.join('')
}

function stripActionMarkersInPlainTextSegment(s: string): string {
  return s.replace(/\[\[([^\]]{1,40})\]\]/g, (match, inner) => {
    if (isActionPlaceholder(inner)) return match
    return ''
  })
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    /* try fallback */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', 'true')
    ta.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch {
    /* ignore */
  }
}

function getRoomBotMeta(roomId: string, userId: string, client: sdk.MatrixClient): { name: string; mxcUrl: string | null } | null {
  const room = client.getRoom(roomId)
  if (!room) return null
  const others = room.getMembersWithMembership('join').filter(m => m.userId !== userId)
  if (others.length === 0) return null
  const m = others[0]
  return { name: m.name ?? shortName(m.userId), mxcUrl: m.getMxcAvatarUrl() ?? null }
}

function SortablePill({ pill, onActivate }: { pill: string; onActivate: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: pill })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  const paramIdx = pill.indexOf('<>')
  const hasParam = paramIdx !== -1
  const label = hasParam ? pill.replace('<>', '…') : pill
  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`pill${hasParam ? ' pill-param' : ''}`}
      onClick={onActivate}
    >
      {label}
    </button>
  )
}

function ThreadBlock({ thread }: { thread: ConstructThread }) {
  const [expanded, setExpanded] = React.useState(false)
  const bodyHtml = React.useMemo(
    () => sanitizeHtml(marked.parse(thread.body, { async: false }) as string),
    [thread.body]
  )
  return (
    <div className={`msg-thread${expanded ? ' msg-thread--open' : ''}`}>
      <button className="msg-thread-header" onClick={() => setExpanded(v => !v)}>
        <span className="material-icons msg-thread-chevron">chevron_right</span>
        <span className="msg-thread-title">{thread.title}</span>
      </button>
      {!expanded && thread.summary && (
        <div className="msg-thread-summary">{thread.summary}</div>
      )}
      {expanded && (
        <div
          className="msg-thread-body bot-text bot-text-rich"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
    </div>
  )
}


function getRoomModel(roomId: string): string | null {
  return localStorage.getItem(`room-model:${roomId}`)
}

function setRoomModel(roomId: string, model: string) {
  localStorage.setItem(`room-model:${roomId}`, model)
}

type MessageMenuPos = { eventId: string; x: number; y: number; body: string }

function openPinContextMenu(
  eventId: string,
  body: string,
  clientX: number,
  clientY: number,
  clearLongPress: () => void,
  setMessageMenu: Dispatch<SetStateAction<MessageMenuPos | null>>,
  messageMenuOpenedAt: { current: number },
  blockRichClickUntil: { current: number },
) {
  clearLongPress()
  const pad = 8
  const mw = 180
  const mh = 80
  const x = Math.min(window.innerWidth - mw - pad, Math.max(pad, clientX - mw / 2))
  const y = Math.min(window.innerHeight - mh - pad, Math.max(pad, clientY + 4))
  const now = Date.now()
  messageMenuOpenedAt.current = now
  blockRichClickUntil.current = now + 450
  setMessageMenu({ eventId, body, x, y })
}

function ChatView({ roomId, isActive, roomName, config, userId, onBack, dictationAutoSend }: Props) {
  // Keyboard show/hide resizes the layout; keep the tail visible, but only
  // if the user was already at the bottom — never yank them out of history.
  useVisualViewportResize(() => {
    if (!stickToBottomRef.current) return
    programmaticScrollUntilRef.current = performance.now() + 100
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
  }, isActive)
  const { toast, showToast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const [cameraPrompt, setCameraPrompt] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showEditor, setShowEditor] = useState(false)
  const [pills, setPills] = useState<string[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(() => getRoomModel(roomId))
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setPills(prev => {
      const oldIndex = prev.indexOf(active.id as string)
      const newIndex = prev.indexOf(over.id as string)
      const next = arrayMove(prev, oldIndex, newIndex)
      savePills(getClient(), roomId, next)
      return next
    })
  }, [roomId])

  const onBotRichTextClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() < blockRichClickUntilRef.current) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const raw = e.target
    if (raw == null || !(raw instanceof Element)) return
    if (raw.closest('a')) return
    const code = raw.closest('code')
    const block: HTMLElement | null = (code as HTMLElement) ?? (raw.closest('pre') as HTMLElement | null)
    if (!block) return
    e.preventDefault()
    const text = block.textContent ?? ''
    void copyTextToClipboard(text).then(() => showToast('Copied'))
  }, [showToast])

  const lastActions = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].isOwnMessage) return parseActions(messages[i].body).actions
    }
    return []
  }, [messages])
  const [addingPill, setAddingPill] = useState(false)
  const [newPillInput, setNewPillInput] = useState('')
  const newPillRef = useRef<HTMLInputElement>(null)
  const [sending, setSending] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [renderStart, setRenderStart] = useState(0)
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const [bot, setBot] = useState<{ name: string; avatarUrl: string | null } | null>(null)
  const [roomAvatarUrl, setRoomAvatarUrl] = useState<string | null>(null)
  const [roomTopic, setRoomTopic] = useState('')
  const [sendError, setSendError] = useState('')
  const [pinError, setPinError] = useState('')
  const [messageMenu, setMessageMenu] = useState<null | MessageMenuPos>(null)
  const [pinInFlight, setPinInFlight] = useState(false)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const footerRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const [pinnedEventIds, setPinnedEventIds] = useState<string[]>([])
  const [pinnedDisplay, setPinnedDisplay] = useState<Message[]>([])
  const [pinnedExpanded, setPinnedExpanded] = useState(true)

  const client = getClient()
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const refreshPinnedRef = useRef<() => void>(() => {})
  const pinnedIdsRef = useRef<Set<string>>(new Set())
  const activeRoomIdRef = useRef(roomId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const autoSendToMessage = useRef<((t: string) => void) | null>(null)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number; eventId: string; pointerId: number } | null>(null)
  const messageMenuOpenedAt = useRef(0)
  const messageMenuRef = useRef<HTMLDivElement | null>(null)
  const blockRichClickUntilRef = useRef(0)

  useEffect(() => {
    activeRoomIdRef.current = roomId
  }, [roomId])

  useEffect(() => {
    setPinnedExpanded(true)
  }, [roomId])

  useEffect(() => {
    if (!isActive) return
    if (window.matchMedia('(max-width: 640px)').matches) return
    textareaRef.current?.focus()
  }, [roomId, isActive])

  const refreshPinned = useCallback(async () => {
    const forRoom = roomId
    const room = client.getRoom(forRoom)
    if (!room) return
    const st = room.currentState.getStateEvents(sdk.EventType.RoomPinnedEvents, '')
    const content = st?.getContent() as { pinned?: string[] } | undefined
    const ids = content?.pinned ?? []
    pinnedIdsRef.current = new Set(ids)
    if (forRoom !== activeRoomIdRef.current) return
    setPinnedEventIds(ids)

    if (ids.length === 0) {
      setPinnedDisplay([])
      return
    }

    // Prefer the local timeline, then GET /rooms/.../event/... for each pin. That works when
    // timelineSupport was off, for thread based pins (getEventTimeline bails on thread roots), etc.
    const eventById = new Map<string, sdk.MatrixEvent>()
    for (const id of ids) {
      const local = room.findEventById(id)
      if (local) eventById.set(id, local)
    }
    const needFetch = ids.filter((id) => !eventById.has(id))
    if (needFetch.length > 0) {
      const mapper = client.getEventMapper()
      await Promise.all(
        needFetch.map(async (id) => {
          try {
            const raw = await client.fetchRoomEvent(forRoom, id)
            const ev = mapper(raw)
            await client.decryptEventIfNeeded(ev)
            eventById.set(id, ev)
          } catch {
            // 404, access denied, etc.
          }
        }),
      )
    }

    if (forRoom !== activeRoomIdRef.current) return

    const maxReadTs = getMaxReadTs(room, userId)
    const resolved: Message[] = []
    for (const id of [...ids].reverse()) {
      const ev = eventById.get(id)
      if (!ev || ev.isRedacted()) continue
      const t = ev.getType()
      if (t !== 'm.room.message' && t !== 'm.room.encrypted' && !ev.isDecryptionFailure()) continue
      resolved.push(eventToMessage(ev, userId, maxReadTs))
    }
    setPinnedDisplay(resolved)
  }, [client, roomId, userId])

  useEffect(() => {
    refreshPinnedRef.current = () => {
      void refreshPinned()
    }
  }, [refreshPinned])

  const visibleMessages = renderStart > 0 ? messages.slice(renderStart) : messages

  useEffect(() => {
    isFirstLoad.current = true
    stickToBottomRef.current = true
    lastTailEventIdRef.current = undefined
    setHasMore(true)
    setMessages([])
    setRenderStart(0)
    setInitializing(true)
    resolvedImagesRef.current = new Set()
    setImageUrls({})
    setCurrentModel(getRoomModel(roomId))

    const room = client.getRoom(roomId)
    if (!room) return

    // Block rendering until we have a stable first batch to avoid jump cascades.
    const populate = (msgs: ReturnType<typeof eventsToMessages>) => {
      setMessages(msgs)
      setInitializing(false)
    }

    const existing = room.getLiveTimeline().getEvents()
    if (existing.length >= 20) {
      populate(eventsToMessages(existing, userId, room))
    } else {
      client.scrollback(room, 20)
        .then(() => populate(eventsToMessages(room.getLiveTimeline().getEvents(), userId, room)))
        .catch(() => populate(eventsToMessages(room.getLiveTimeline().getEvents(), userId, room)))
    }

    const onEvent = (event: sdk.MatrixEvent, room_: sdk.Room | undefined) => {
      if (room_?.roomId !== roomId) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return
      const maxReadTs = getMaxReadTs(room_, userId)
      const msg = eventToMessage(event, userId, maxReadTs)
      if (!msg.isOwnMessage) {
        const content = event.getContent()
        const eventModel: string | undefined = content['com.construct.model']
        if (eventModel) {
          setRoomModel(roomId, eventModel)
          setCurrentModel(eventModel)
        }
      }
      setMessages((prev) => {
        const id = event.getId() ?? ''
        // m.replace edits (streamed responses, tool progress) update the
        // target bubble in place; appending them would duplicate the text.
        const rel = event.getRelation()
        if (rel?.rel_type === 'm.replace' && rel.event_id) {
          const targetId = rel.event_id
          if (prev.some((m) => m.eventId === targetId)) {
            return prev
              .filter((m) => m.eventId !== id)
              .map((m) => (m.eventId === targetId
                ? { ...msg, eventId: m.eventId, timestamp: m.timestamp, reactions: m.reactions, isRead: m.isRead }
                : m))
          }
          // Target not rendered (scrolled out of window) — fall through
          // and keep the edit as a standalone bubble so content shows.
        }
        if (prev.some((m) => m.eventId === id)) return prev
        const next = [...prev, msg]
        return next.length > MSG_CAP ? next.slice(next.length - MSG_CAP) : next
      })
    }

    // Send read receipt when opening room
    client.sendReadReceipt(room.getLiveTimeline().getEvents().at(-1) ?? null)
      .catch(() => {})

    // Re-render message when decryption completes late
    const onDecrypted = (event: sdk.MatrixEvent) => {
      if (event.getRoomId() !== roomId) return
      if (event.isDecryptionFailure()) {
        // Try to fetch missing keys from key backup
        client.getCrypto()?.checkKeyBackupAndEnable().catch(() => {})
      }
      const room_ = client.getRoom(roomId)
      const maxReadTs = room_ ? getMaxReadTs(room_, userId) : 0
      const decrypted = eventToMessage(event, userId, maxReadTs)
      const rel = event.getRelation()
      setMessages((prev) => {
        const id = event.getId() ?? ''
        // Decrypted m.replace edits fold into their target bubble; drop
        // the encrypted placeholder appended before decryption revealed
        // the relation.
        if (rel?.rel_type === 'm.replace' && rel.event_id && prev.some((m) => m.eventId === rel.event_id)) {
          return prev
            .filter((m) => m.eventId !== id)
            .map((m) => (m.eventId === rel.event_id
              ? { ...decrypted, eventId: m.eventId, timestamp: m.timestamp, reactions: m.reactions, isRead: m.isRead }
              : m))
        }
        return prev.map((m) => (m.eventId === id ? decrypted : m))
      })
      if (pinnedIdsRef.current.has(event.getId() ?? '')) {
        refreshPinnedRef.current()
      }
    }

    const onReceipt = (_event: sdk.MatrixEvent, room_: sdk.Room) => {
      if (room_.roomId !== roomId) return
      const maxReadTs = getMaxReadTs(room_, userId)
      if (maxReadTs === 0) return
      setMessages((prev) => {
        let changed = false
        const next = prev.map((m) => {
          if (!m.isOwnMessage || m.isRead || m.timestamp > maxReadTs) return m
          changed = true
          return { ...m, isRead: true }
        })
        return changed ? next : prev
      })
    }

    const onTimeline = (event: sdk.MatrixEvent, room_: sdk.Room | undefined) => {
      if (event.getType() === 'm.reaction') {
        if (room_?.roomId !== roomId) return
        const rel = event.getContent()['m.relates_to']
        if (!rel || rel.rel_type !== 'm.annotation') return
        const targetId = rel.event_id as string
        const emoji = rel.key as string
        const sender = event.getSender() ?? ''
        setMessages((prev) => prev.map((m) => {
          if (m.eventId !== targetId) return m
          const reactions = { ...(m.reactions ?? {}) }
          const senders = reactions[emoji] ? [...reactions[emoji]] : []
          if (!senders.includes(sender)) senders.push(sender)
          reactions[emoji] = senders
          return { ...m, reactions }
        }))
      } else {
        onEvent(event, room_)
      }
    }

    client.on(sdk.MatrixEventEvent.Decrypted, onDecrypted)
    client.on(sdk.RoomEvent.Timeline, onTimeline)
    client.on(sdk.RoomEvent.Receipt, onReceipt)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onTimeline)
      client.off(sdk.MatrixEventEvent.Decrypted, onDecrypted)
      client.off(sdk.RoomEvent.Receipt, onReceipt)
    }
  }, [roomId, userId, client])

  // Compute bot info reactively — members may be lazy-loaded. Listen on
  // room.currentState rather than the client so we don't wake up for
  // every member change in every other joined room.
  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return
    let cancelled = false
    const update = async () => {
      const meta = getRoomBotMeta(roomId, userId, client)
      if (!meta) {
        if (!cancelled) setBot((prev) => (prev === null ? prev : null))
        return
      }
      const avatarUrl = meta.mxcUrl ? await resolveMediaUrl(client, meta.mxcUrl, 80, 80, 'crop') : null
      if (cancelled) return
      setBot((prev) => {
        if (prev && prev.name === meta.name && prev.avatarUrl === avatarUrl) return prev
        return { name: meta.name, avatarUrl }
      })
    }
    update()
    room.loadMembersIfNeeded().then(update).catch(() => {})
    const onMembers = (_e: sdk.MatrixEvent, _s: sdk.RoomState, member: sdk.RoomMember) => {
      if (member.userId !== userId) update()
    }
    room.currentState.on(sdk.RoomStateEvent.Members, onMembers)
    return () => {
      cancelled = true
      room.currentState.off(sdk.RoomStateEvent.Members, onMembers)
    }
  }, [roomId, userId, client])

  // m.room.topic for subtitle (when non-empty); listen for state updates
  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) {
      setRoomTopic('')
      return
    }
    const readTopic = () => {
      const ev = room.currentState.getStateEvents(sdk.EventType.RoomTopic, '')
      const raw = ev?.getContent()?.topic
      const t = typeof raw === 'string' ? raw.trim() : ''
      setRoomTopic(t)
    }
    readTopic()
    const onState = (ev: sdk.MatrixEvent) => {
      if (ev.getRoomId() !== roomId) return
      if (ev.getType() === sdk.EventType.RoomTopic) readTopic()
    }
    room.currentState.on(sdk.RoomStateEvent.Events, onState)
    return () => { room.currentState.off(sdk.RoomStateEvent.Events, onState) }
  }, [roomId, client])

  // Resolve room's own avatar URL
  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return
    const mxcUrl = room.getMxcAvatarUrl()
    if (!mxcUrl) { setRoomAvatarUrl(null); return }
    let cancelled = false
    resolveMediaUrl(client, mxcUrl, 80, 80, 'crop').then(url => {
      if (!cancelled) setRoomAvatarUrl(url ?? null)
    })
    return () => { cancelled = true }
  }, [roomId, client])

  // Resolve mxc image URLs to authenticated blob URLs. Kept out of
  // `messages` so resolution doesn't mutate the message array and
  // re-trigger this effect in a feedback loop.
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({})
  const [expandedToolGroups] = useState<Set<string>>(new Set())
  const [toolDialog, setToolDialog] = useState<{ lines: ReturnType<typeof parseToolProgressMessage> } | null>(null)
  const [expandedToolLine, setExpandedToolLine] = useState<string | null>(null)
  const resolvedImagesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const toResolve: { eventId: string; mxc: string }[] = []
    for (const m of messages) {
      const mxc = m.imageMxc ?? m.fileMxc
      if (mxc && !m.imageUrl && !resolvedImagesRef.current.has(m.eventId)) {
        resolvedImagesRef.current.add(m.eventId)
        toResolve.push({ eventId: m.eventId, mxc })
      }
    }
    for (const m of pinnedDisplay) {
      const mxc = m.imageMxc ?? m.fileMxc
      if (mxc && !m.imageUrl && !resolvedImagesRef.current.has(m.eventId)) {
        resolvedImagesRef.current.add(m.eventId)
        toResolve.push({ eventId: m.eventId, mxc })
      }
    }
    if (toResolve.length === 0) return
    let cancelled = false
    Promise.all(toResolve.map(async ({ eventId, mxc }) => {
      const url = await resolveMediaUrl(client, mxc)
      return { eventId, url }
    })).then(results => {
      if (cancelled) return
      setImageUrls(prev => {
        const next = { ...prev }
        let changed = false
        for (const r of results) {
          if (r.url && !next[r.eventId]) { next[r.eventId] = r.url; changed = true }
        }
        return changed ? next : prev
      })
    })
    return () => { cancelled = true }
  }, [messages, pinnedDisplay, client])

  // Pinned events (m.room.pinned_events) — resolve when state changes or the timeline may contain them
  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return
    refreshPinned()
    const onState = (ev: sdk.MatrixEvent) => {
      if (ev.getType() === sdk.EventType.RoomPinnedEvents) refreshPinned()
    }
    room.currentState.on(sdk.RoomStateEvent.Events, onState)
    return () => { room.currentState.off(sdk.RoomStateEvent.Events, onState) }
  }, [roomId, client, refreshPinned])

  useEffect(() => {
    if (pinnedEventIds.length === 0) return
    refreshPinned()
  }, [messages.length, pinnedEventIds.length, refreshPinned])

  // Typing indicators
  useEffect(() => {
    const onTyping = (_event: sdk.MatrixEvent, member: sdk.RoomMember) => {
      if (member.roomId !== roomId) return
      const room = client.getRoom(roomId)
      if (!room) return
      const typing = room.getMembersWithMembership('join')
        .filter((m) => m.typing && m.userId !== userId)
        .map((m) => m.userId.replace(/^@/, '').split(':')[0])
      setTypingUsers(typing)
    }
    client.on(sdk.RoomMemberEvent.Typing, onTyping)
    return () => { client.off(sdk.RoomMemberEvent.Typing, onTyping) }
  }, [roomId, userId, client])

  // Keep scroll-down button in sync after renders (not just on scroll events)
  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150
    setShowScrollDown(!isNearBottom)
  }, [visibleMessages, renderStart])


  // Scroll policy: stay pinned to bottom unless the user scrolls away.
  //   - stickToBottomRef starts true and is toggled by handleScroll.
  //   - Use 'instant' scroll for sticky-to-bottom updates. A 'smooth'
  //     scroll during the async decryption/scrollback cascade races
  //     with its own scroll events (which would briefly show us as
  //     "not near bottom" mid-animation), and with further content
  //     being appended after the animation target was already locked.
  //   - Suppress stickToBottom changes while a programmatic scroll is
  //     in flight so the scroll handler doesn't see the intermediate
  //     position and flip the flag to false.
  const isFirstLoad = useRef(true)
  const stickToBottomRef = useRef(true)
  const lastTailEventIdRef = useRef<string | undefined>(undefined)
  const programmaticScrollUntilRef = useRef(0)
  const wasActiveRef = useRef(false)
  const loadingMoreRef = useRef(false)
  // When loading older messages (scrollback or render-window slide), store
  // the scrollHeight before the state update here. useLayoutEffect restores
  // the anchor synchronously after the DOM update, before any paint.
  const scrollAnchorRef = useRef<number | null>(null)
  const suppressRenderStartRef = useRef(false)

  // When this room is shown again, its ChatView was only hidden (display)
  // but kept state — scroll position and renderStart are preserved, so
  // we never auto-scroll. Reset to the tail and pin to bottom.
  useLayoutEffect(() => {
    /* eslint-disable react-hooks/immutability, react-hooks/set-state-in-effect -- must sync refs + renderStart before the visible-messages useLayoutEffect in the same commit */
    if (!isActive) {
      wasActiveRef.current = false
      return
    }
    const justBecameActive = !wasActiveRef.current
    wasActiveRef.current = true
    if (!justBecameActive) return
    const n = messages.length
    stickToBottomRef.current = true
    isFirstLoad.current = true
    setShowScrollDown(false)
    lastTailEventIdRef.current = undefined
    if (n > RENDER_LIMIT) {
      const newStart = Math.max(0, n - RENDER_LIMIT)
      setRenderStart(newStart)
      const visibleIds = new Set(messages.slice(newStart).map(m => m.eventId))
      resolvedImagesRef.current = new Set([...resolvedImagesRef.current].filter(id => visibleIds.has(id)))
      setImageUrls(prev => {
        const next: Record<string, string> = {}
        for (const id of visibleIds) if (prev[id]) next[id] = prev[id]
        return next
      })
    } else {
      setRenderStart(0)
    }
    programmaticScrollUntilRef.current = performance.now() + 200
    /* eslint-enable react-hooks/immutability, react-hooks/set-state-in-effect */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = messagesRef.current
        if (!el) return
        el.scrollTop = el.scrollHeight - el.clientHeight
        bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
      })
    })
  }, [isActive, messages.length])

  // useLayoutEffect so we set scrollTop before the browser paints the new
  // content. Otherwise there's a one-frame flash where the new messages
  // render at the top of the scroll container before being scrolled down.
  useLayoutEffect(() => {
    if (visibleMessages.length === 0) return

    // Restore scroll anchor synchronously after prepending older messages.
    // This runs before paint, avoiding the RAF race that caused position jumps.
    const anchor = scrollAnchorRef.current
    if (anchor !== null) {
      scrollAnchorRef.current = null
      const container = messagesRef.current
      if (container) {
        const target = container.scrollHeight - anchor
        container.scrollTop = target
        // Double-check after paint in case iOS deferred the layout flush
        requestAnimationFrame(() => {
          if (container.scrollTop !== target) container.scrollTop = target
        })
      }
      loadingMoreRef.current = false
      return
    }

    const tail = visibleMessages[visibleMessages.length - 1]
    const tailChanged = tail.eventId !== lastTailEventIdRef.current
    lastTailEventIdRef.current = tail.eventId
    const shouldScroll = (stickToBottomRef.current || (tailChanged && tail.isOwnMessage)) && !loadingMoreRef.current
    if (!shouldScroll) return
    const behavior: ScrollBehavior = (!isFirstLoad.current && tailChanged && tail.isOwnMessage) ? 'smooth' : 'instant'
    isFirstLoad.current = false
    programmaticScrollUntilRef.current = performance.now() + (behavior === 'smooth' ? 500 : 100)
    bottomRef.current?.scrollIntoView({ block: 'end', behavior })
  }, [visibleMessages])

  // Load pills — retry on sync (account data may not be in-memory until first SYNCING)
  useEffect(() => {
    let cancelled = false
    const load = () => loadPills(client, roomId).then(p => { if (!cancelled) setPills(p) })

    load()

    const onSync = (state: string) => { if (state === 'SYNCING') load() }
    const onAccountData = (event: sdk.MatrixEvent) => {
      if (event.getType() === 'com.matrix-pwa.room-pills') load()
    }

    client.on(sdk.ClientEvent.Sync, onSync)
    client.on(sdk.ClientEvent.AccountData, onAccountData)
    return () => {
      cancelled = true
      client.off(sdk.ClientEvent.Sync, onSync)
      client.off(sdk.ClientEvent.AccountData, onAccountData)
    }
  }, [roomId, client])

  // Scroll to bottom when own message is sent
  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
  }, [])

  // Load older messages
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    const room = client.getRoom(roomId)
    if (!room) return

    const container = messagesRef.current

    // User is scrolling up — unpin from bottom so the messages.length effect
    // doesn't advance renderStart to the tail after new messages are loaded.
    stickToBottomRef.current = false
    programmaticScrollUntilRef.current = 0

    setLoadingMore(true)
    loadingMoreRef.current = true
    try {
      const result = await client.scrollback(room, PAGE_SIZE)
      const allEvents = result.getLiveTimeline().getEvents()
      const msgs = eventsToMessages(allEvents, userId, result)

      // Capture scrollHeight immediately before the state update so
      // useLayoutEffect can restore the anchor before the next paint.
      suppressRenderStartRef.current = true
      scrollAnchorRef.current = container ? container.scrollHeight - container.scrollTop : 0
      setMessages(msgs)

      if (result.oldState.paginationToken === null) {
        setHasMore(false)
      }
    } catch {
      setHasMore(false)
      loadingMoreRef.current = false
    } finally {
      setLoadingMore(false)
    }
  }, [client, roomId, userId, loadingMore, hasMore])

  // Slide render window up when user scrolls to top of rendered slice
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const scrollTop = el.scrollTop
    const isNearBottom = el.scrollHeight - scrollTop - el.clientHeight < 150
    // Ignore scroll events fired by our own programmatic scrollIntoView
    // so we don't see the mid-animation position as "user scrolled up".
    if (performance.now() >= programmaticScrollUntilRef.current) {
      stickToBottomRef.current = isNearBottom
    } else if (isNearBottom) {
      stickToBottomRef.current = true
    }
    setShowScrollDown(!isNearBottom)
    if (scrollTop < 80 && !loadingMore && hasMore) {
      loadMore()
    }
  }

  // Autocomplete
  useEffect(() => {
    const all = [...pills, ...(config?.suggestions ?? [])]
    if (input.trim().length < 2 || !all.length) {
      setSuggestions([])
      return
    }
    const q = input.toLowerCase()
    setSuggestions(all.filter((s) => s.toLowerCase().includes(q)).slice(0, 5))
  }, [input, config])

  const onAutoSend = useCallback((text: string) => {
    void autoSendToMessage.current?.(text)
  }, [])

  // Feed dictation text to the compose box and (native) the island transcript.
  const onDictationText = useCallback((full: string) => {
    setInput(full)
    updateListeningTranscript(full)
  }, [])

  const {
    dictating,
    userSpeaking,
    start: startDictation,
    stop: stopDictation,
    error: dictationError,
    clearError: clearDictationError,
    supported: dictationSupported,
  } = useSpeechDictation(onDictationText, { onAutoSend })
  const showDictation = useMemo(() => isMobileSafari() || Capacitor.isNativePlatform(), [])

  // Drive the "Listening…" Live Activity from dictation state (native only).
  const dictatingRef = useRef(false)
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    if (dictating && !dictatingRef.current) {
      dictatingRef.current = true
      void startListening(roomName, roomId)
    } else if (!dictating && dictatingRef.current) {
      dictatingRef.current = false
      // If an auto-send fired, startAwaitingReply already took over the
      // activity; stopListening only ends it when still in the listen phase.
      void stopListening()
    }
  }, [dictating, roomName])

  useEffect(() => {
    stopDictation()
  }, [roomId, stopDictation])

  // ?camera=1 — open camera/file picker after navigation
  useEffect(() => {
    if (!isActive) return
    const camera = searchParams.get('camera')
    if (!camera) return
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('camera'); return next }, { replace: true })
    setCameraPrompt(true)
  }, [isActive, roomId, searchParams])

  // ?listen=true (or 1) — start dictation after navigation; strip the param (active room only)
  useEffect(() => {
    if (!isActive) return
    const listen = searchParams.get('listen')
    if (!listen) return
    if (sending) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('listen')
        return next
      },
      { replace: true },
    )
    if (!dictationSupported) return
    setTimeout(() => {
      startDictation(input, dictationAutoSend ? { autoSend: true } : undefined)
    }, 300)
  }, [
    isActive,
    roomId,
    searchParams,
    sending,
    dictationSupported,
    startDictation,
    dictationAutoSend,
    input,
    setSearchParams,
  ])


  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || sending) return
    stopDictation()
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setSuggestions([])
    setSending(true)
    requestAnimationFrame(scrollToBottom)
    try {
      await client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: text,
        'com.construct.capabilities': ['actionable'],
        'com.construct.client': 'construct-web',
        'com.construct.version': __CONSTRUCT_VERSION__,
      } as any)
    } catch (err: any) {
      setInput(text) // restore input so message isn't lost
      setSendError(err?.message ?? 'Failed to send')
      setTimeout(() => setSendError(''), 4000)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }, [client, roomId, sending, scrollToBottom, stopDictation])


  const sendReaction = useCallback(async (eventId: string, emoji: string) => {
    try {
      await client.sendEvent(roomId, 'm.reaction' as any, {
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key: emoji },
      })
    } catch {
      // ignore — reaction is best-effort
    }
  }, [client, roomId])

  const sendFile = useCallback(async (file: File) => {
    if (sending) return
    setSending(true)
    try {
      const upload = await client.uploadContent(file, { name: file.name, type: file.type })
      const mxc = upload.content_uri
      const isImage = file.type.startsWith('image/')
      const msgContent: Record<string, unknown> = {
        msgtype: isImage ? 'm.image' : 'm.file',
        body: file.name,
        url: mxc,
        info: { mimetype: file.type, size: file.size },
      }
      if (isImage) {
        await new Promise<void>((resolve) => {
          const img = new Image()
          img.onload = () => {
            msgContent.info = { ...msgContent.info as object, w: img.naturalWidth, h: img.naturalHeight }
            resolve()
          }
          img.onerror = () => resolve()
          img.src = URL.createObjectURL(file)
        })
      }
      await client.sendMessage(roomId, msgContent as any)
    } catch (err: any) {
      setSendError(err?.message ?? 'Failed to send file')
      setTimeout(() => setSendError(''), 4000)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }, [client, roomId, sending])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setDragOver(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) void sendFile(file)
  }, [sendFile])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const fileItem = items.find(it => it.kind === 'file')
    if (!fileItem) return
    const file = fileItem.getAsFile()
    if (!file) return
    e.preventDefault()
    void sendFile(file)
  }, [sendFile])

  useLayoutEffect(() => {
    autoSendToMessage.current = (t) => {
      void sendMessage(t)
      // Dictated sends surface the reply in the Dynamic Island (native only)
      void startAwaitingReply(roomId, roomName, t)
    }
  }, [sendMessage, roomId, roomName])

  // Feed incoming messages to the Live Activity reply flow (native only).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const feed = (event: sdk.MatrixEvent) => {
      if (event.getRoomId() !== roomId) return
      if (event.getType() !== 'm.room.message') return
      if (event.getSender() === userId) return
      const content = event.getContent() as { body?: string; 'm.new_content'?: { body?: string } }
      // Streamed edits (m.replace) carry the real text in m.new_content.
      const body = content['m.new_content']?.body ?? content.body ?? ''
      maybeShowReply(roomId, body)
    }
    const onTimeline = (event: sdk.MatrixEvent) => feed(event)
    const onDecrypted = (event: sdk.MatrixEvent) => feed(event)
    client.on(sdk.RoomEvent.Timeline, onTimeline)
    client.on(sdk.MatrixEventEvent.Decrypted, onDecrypted)

    // Resume catch-up: while backgrounded, the WebView's JS/sync is
    // suspended even though the audio session keeps the process alive, so
    // the reply that arrived is only seen on return. On foreground, scan the
    // room for bender's latest message newer than when the wait began.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const awaiting = awaitingReply()
      if (!awaiting || awaiting.roomId !== roomId) return
      const events = client.getRoom(roomId)?.getLiveTimeline().getEvents() ?? []
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]!
        if (ev.getType() !== 'm.room.message' || ev.getSender() === userId) continue
        if (ev.getTs() < awaiting.since) break
        maybeShowReply(roomId, (ev.getContent().body as string | undefined) ?? '')
        break
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onTimeline)
      client.off(sdk.MatrixEventEvent.Decrypted, onDecrypted)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [client, roomId, userId])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null || touchStartY.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY.current)
    // Right swipe from left edge: dx > 60px, not too vertical, started within 40px of left edge
    if (dx > 60 && dy < 80 && touchStartX.current < 40) {
      onBack()
    }
    touchStartX.current = null
    touchStartY.current = null
  }

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null
  }, [])

  const showMessageMenuAt = useCallback(
    (eventId: string, body: string, clientX: number, clientY: number) => {
      openPinContextMenu(
        eventId,
        body,
        clientX,
        clientY,
        clearLongPressTimer,
        setMessageMenu,
        messageMenuOpenedAt,
        blockRichClickUntilRef,
      )
    },
    [clearLongPressTimer],
  )

  const onPinContextMenu = useCallback(
    (eventId: string, body: string) => (e: React.MouseEvent) => {
      e.preventDefault()
      clearLongPressTimer()
      showMessageMenuAt(eventId, body, e.clientX, e.clientY)
    },
    [clearLongPressTimer, showMessageMenuAt],
  )

  const onPinPointerDown = useCallback(
    (eventId: string, body: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const x0 = e.clientX
      const y0 = e.clientY
      longPressStartRef.current = { x: x0, y: y0, eventId, pointerId: e.pointerId }
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        if (longPressStartRef.current?.eventId !== eventId) return
        longPressStartRef.current = null
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            ;(navigator as Navigator & { vibrate: (n: number) => boolean }).vibrate(12)
          } catch { /* */ }
        }
        showMessageMenuAt(eventId, body, x0, y0)
      }, PIN_LONG_PRESS_MS)
    },
    [showMessageMenuAt],
  )

  const onPinPointerMove = useCallback((e: React.PointerEvent) => {
    const s = longPressStartRef.current
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (dx * dx + dy * dy > PIN_MOVE_CANCEL_PX * PIN_MOVE_CANCEL_PX) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
      longPressStartRef.current = null
    }
  }, [])

  const onPinPointerUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null
  }, [])

  const onPinOrUnpin = useCallback(async () => {
    if (!messageMenu) return
    setPinInFlight(true)
    setPinError('')
    const id = messageMenu.eventId
    const isPinned = pinnedIdsRef.current.has(id)
    try {
      if (isPinned) await unpinRoomEvent(roomId, id)
      else await pinRoomEvent(roomId, id)
      setMessageMenu(null)
      refreshPinnedRef.current()
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : 'Could not update pins'
      setPinError(m)
      setTimeout(() => setPinError(''), 5000)
    } finally {
      setPinInFlight(false)
    }
  }, [messageMenu, roomId])

  useEffect(() => {
    if (!messageMenu) return
    const onDocPointerDown = (e: PointerEvent) => {
      if (Date.now() - messageMenuOpenedAt.current < MENU_DISMISS_GRACE_MS) return
      if (messageMenuRef.current?.contains(e.target as Node)) return
      setMessageMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMessageMenu(null)
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [messageMenu])

  return (
    <div
      className="chat-view"
      onTouchStart={enableSwipeBack ? handleTouchStart : undefined}
      onTouchEnd={enableSwipeBack ? handleTouchEnd : undefined}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {toast && <div className="toast">{toast}</div>}
      {dragOver && (
        <div className="drop-overlay">
          <span className="material-icons drop-overlay-icon">upload_file</span>
          <span>Drop to send</span>
        </div>
      )}
      <div className="chat-header">
        <div className="chat-header-inner">
          <button className="back" onClick={onBack}>←</button>
          {roomAvatarUrl
            ? <img className="chat-avatar" src={roomAvatarUrl} alt="" />
            : <div className="chat-avatar chat-avatar-fallback">{roomName.slice(0, 1).toUpperCase()}</div>}
          <div className="chat-header-info" onClick={() => setShowEditor(true)} style={{ cursor: 'pointer' }}>
            <span className="chat-title">{roomName}</span>
            <span className={`chat-subtitle${typingUsers.length > 0 ? ' chat-subtitle--thinking' : ''}`}>
              {typingUsers.length > 0
                ? `${bot?.name ?? 'Bot'} is thinking…`
                : (roomTopic || (bot?.name ?? null))}
            </span>
          </div>
          {currentModel && (
            <span className="chat-header-model" title={`Model: ${currentModel}`}>
              {currentModel}
            </span>
          )}
          {pinnedEventIds.length > 0 && (
            <button
              type="button"
              className="header-pinned"
              id="pinned-messages-button"
              aria-expanded={pinnedExpanded}
              aria-controls={pinnedExpanded ? 'pinned-messages-content' : undefined}
              aria-label={pinnedExpanded ? 'Hide pinned messages' : 'Show pinned messages'}
              title={pinnedExpanded ? 'Hide pinned' : 'Show pinned'}
              onClick={() => setPinnedExpanded((v) => !v)}
            >
              <span className="material-icons header-pinned-icon" aria-hidden>push_pin</span>
              <span className="material-icons header-pinned-chevron" aria-hidden>
                {pinnedExpanded ? 'expand_less' : 'expand_more'}
              </span>
            </button>
          )}
        </div>
      </div>

      {showEditor && <RoomEditor roomId={roomId} onClose={() => { setShowEditor(false); loadPills(client, roomId).then(setPills) }} onLeave={() => { setShowEditor(false); onBack() }} />}
      {toolDialog && (
        <div className="room-editor-overlay" onClick={() => { setToolDialog(null); setExpandedToolLine(null) }}>
          <div className="room-editor" onClick={e => e.stopPropagation()}>
            <div className="room-editor-header">
              <span className="room-editor-title">Tool activity</span>
              <button className="room-editor-close" onClick={() => { setToolDialog(null); setExpandedToolLine(null) }}>✕</button>
            </div>
            <div className="room-editor-body" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {toolDialog.lines.map((l, idx) => {
                const key = `${idx}-${l.raw ?? l.tool}`
                const isExpanded = expandedToolLine === key
                return (
                  <div
                    key={idx}
                    className={`tool-dialog-line${l.content !== undefined ? ' tool-dialog-line-tappable' : ''}`}
                    onClick={() => l.content !== undefined && setExpandedToolLine(isExpanded ? null : key)}
                  >
                    <div className="tool-progress-line" style={{ fontSize: 13 }}>
                      <span className="tool-progress-emoji">{l.emoji}</span>
                      <span className="tool-progress-tool">{l.tool}</span>
                      {l.content !== undefined && <span className="tool-progress-content">{l.content}</span>}
                      {l.repeat !== undefined && <span className="tool-progress-repeat">×{l.repeat}</span>}
                    </div>
                    {isExpanded && l.raw && (
                      <div className="tool-dialog-raw">{l.raw}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {pinnedEventIds.length > 0 && pinnedExpanded && (
        <div className="pinned-strip" role="region" aria-label="Pinned messages">
          <div className="pinned-strip-inner" id="pinned-messages-content" role="group" aria-labelledby="pinned-messages-button">
            {pinnedDisplay.length === 0 && (
              <p className="pinned-placeholder">This pinned message could not be loaded.</p>
            )}
            {pinnedDisplay.map((msg) => {
              const { text: plain } = parseActions(msg.body)
              const cleanHtml = msg.formattedBody
                ? stripActionMarkersInRichHtml(msg.formattedBody).trim()
                : undefined
              const imgUrl = msg.imageMxc ? (msg.imageUrl ?? imageUrls[msg.eventId]) : undefined
              return (
                <div
                  key={msg.eventId}
                  className={`message-pin-surface message-pin-surface--pinned pinned-body${cleanHtml ? ' pinned-body-rich' : ''}`}
                  onClick={cleanHtml ? onBotRichTextClick : undefined}
                  onPointerDown={onPinPointerDown(msg.eventId, msg.body)}
                  onPointerMove={onPinPointerMove}
                  onPointerUp={onPinPointerUp}
                  onPointerCancel={onPinPointerUp}
                  onContextMenu={onPinContextMenu(msg.eventId, msg.body)}
                >
                  {imgUrl ? (
                    <>
                      <img className="pinned-image" src={imgUrl} alt="" />
                      {(plain || msg.body)?.trim() ? (
                        <div className="pinned-caption">{plain || msg.body}</div>
                      ) : null}
                    </>
                  ) : cleanHtml ? (
                    <span dangerouslySetInnerHTML={{ __html: cleanHtml }} />
                  ) : (
                    (plain || msg.body)
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {initializing && (
        <div className="messages-init-loading">
          <span className="loading-dots"><span /><span /><span /></span>
        </div>
      )}
      <div className="messages" ref={messagesRef} onScroll={handleScroll} style={initializing ? { visibility: 'hidden' } : undefined}>
        <div className="messages-inner">
          {loadingMore && (
            <div className="load-more">
              <span className="loading-dots"><span /><span /><span /></span>
            </div>
          )}

          {((() => {
            // Precompute tool group IDs: each tool msg maps to its group's start eventId
            const toolGroupId: Record<string, string> = {}
            const collapsibleGroups = new Set<string>()
            let currentGroupStart = ''
            for (let i = 0; i < visibleMessages.length; i++) {
              const m = visibleMessages[i]
              const p = i > 0 ? visibleMessages[i - 1] : null
              const n = i + 1 < visibleMessages.length ? visibleMessages[i + 1] : null
              const iT = !m.isOwnMessage && isToolProgressMessage(m.body, m)
              if (!iT) continue
              const pT = p && !p.isOwnMessage && isToolProgressMessage(p.body, p)
              const nT = n && !n.isOwnMessage && isToolProgressMessage(n.body, n)
              if (!pT) currentGroupStart = m.eventId
              toolGroupId[m.eventId] = currentGroupStart
              if (!nT && n !== null) collapsibleGroups.add(currentGroupStart)
            }
            return <>{visibleMessages.map((msg, i) => {
            const showDateDivider = i === 0 || !sameDay(visibleMessages[i - 1].timestamp, msg.timestamp)
            const imageUrl = msg.imageUrl ?? (msg.imageMxc ? imageUrls[msg.eventId] : undefined)
            const fileUrl = msg.fileMxc ? imageUrls[msg.eventId] : undefined
            const isTool = !msg.isOwnMessage && isToolProgressMessage(msg.body, msg)
            const prev = i > 0 ? visibleMessages[i - 1] : null
            const next = i + 1 < visibleMessages.length ? visibleMessages[i + 1] : null
            const prevIsTool = !showDateDivider && prev && !prev.isOwnMessage && isToolProgressMessage(prev.body, prev)
            const nextIsTool = next && !next.isOwnMessage && isToolProgressMessage(next.body, next) &&
              sameDay(msg.timestamp, next.timestamp)
            const canPin = !msg.isDecryptionFailure
            const pinSurfaceProps = canPin
              ? {
                onPointerDown: onPinPointerDown(msg.eventId, msg.body),
                onPointerMove: onPinPointerMove,
                onPointerUp: onPinPointerUp,
                onPointerCancel: onPinPointerUp,
                onContextMenu: onPinContextMenu(msg.eventId, msg.body),
              }
              : {}
            return (
              <div
                key={msg.eventId}
                className={isTool ? `tool-progress-wrap${prevIsTool ? ' tool-progress-wrap-cont' : ''}${nextIsTool ? ' tool-progress-wrap-open' : ''}` : undefined}
              >
                {showDateDivider && (
                  <div className="date-divider">
                    <span>{formatDate(msg.timestamp)}</span>
                  </div>
                )}
                <div className={`message ${msg.isOwnMessage ? 'own' : 'other'}${prev && !showDateDivider && prev.isOwnMessage !== msg.isOwnMessage ? ' sender-switch' : ''}`}>
                  <div className="message-body">
                    {msg.isOwnMessage ? (
                      <>
                        <div className="message-pin-surface message-pin-surface--own" {...pinSurfaceProps}>
                          <div className={`bubble ${msg.isDecryptionFailure ? 'bubble-failed' : ''} ${imageUrl ? 'bubble-image' : ''} ${msg.source === 'voice' ? 'bubble-voice' : ''}`}>
                            {msg.source === 'voice' && (
                              <span className="material-icons bubble-voice-icon" title="Voice input">mic</span>
                            )}
                            {imageUrl
                              ? <img src={imageUrl} alt={msg.body || 'image'} className="msg-image" />
                              : fileUrl
                                ? <a href={fileUrl} download={msg.fileName} className="msg-file" target="_blank" rel="noreferrer"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</a>
                                : msg.fileMxc && !fileUrl
                                  ? <span className="msg-file msg-file-loading"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</span>
                                  : msg.body}
                          </div>
                        </div>
                        <div className={`msg-status ${msg.isRead ? 'msg-status-read' : ''}`}>
                          {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                            <span className="reaction-bar reaction-bar--own-inline">
                              {Object.entries(msg.reactions).map(([emoji, senders]) => (
                                <span key={emoji} className="reaction-pill--own">
                                  {emoji}{senders.length > 1 && <span className="reaction-count">{senders.length}</span>}
                                </span>
                              ))}
                            </span>
                          )}
                          <span className="material-icons">{msg.isRead ? 'done_all' : 'done'}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        {(() => {
                          if (isTool) {
                            const groupId = toolGroupId[msg.eventId]
                            const isGroupStart = !prevIsTool
                            // isGroupEnd = !nextIsTool (unused but kept for clarity)
                            void collapsibleGroups
                            void expandedToolGroups

                            // Non-start messages in any group are hidden — summary shown at group start
                            if (!isGroupStart) return null

                            // All groups show as a summary chip (live group updates in real time)
                            const allLines = visibleMessages
                              .filter(m => toolGroupId[m.eventId] === groupId)
                              .flatMap(m => parseToolProgressMessage(m.body, m))
                            const summary = summarizeToolLines(allLines)
                            const isLive = !collapsibleGroups.has(groupId)
                            return (
                              <div
                                className={`tool-progress tool-progress-collapsed${isLive ? ' tool-progress-live' : ''}`}
                                onClick={() => setToolDialog({ lines: allLines })}
                              >
                                <span className="tool-progress-tool">{summary}</span>
                                {isLive && <span className="tool-progress-live-dot" />}
                              </div>
                            )

                            // dead code kept for type-checker
                            const lines = parseToolProgressMessage(msg.body, msg)
                            return (
                              <div
                                className={`message-pin-surface message-pin-surface--tool tool-progress${prevIsTool ? ' tool-progress-cont' : ''}${nextIsTool ? ' tool-progress-open' : ''}`}
                                {...pinSurfaceProps}
                              >
                                {lines.map((l, idx) => (
                                  <div key={idx} className="tool-progress-line">
                                    <span className="tool-progress-emoji">{l.emoji}</span>
                                    <span className="tool-progress-tool">{l.tool}</span>
                                    {l.content !== undefined && (
                                      <span className="tool-progress-content">{l.content}</span>
                                    )}
                                    {l.repeat !== undefined && (
                                      <span className="tool-progress-repeat">×{l.repeat}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )
                          }
                          const { text } = parseActions(msg.body)
                          const cleanHtml = msg.formattedBody
                            ? stripActionMarkersInRichHtml(msg.formattedBody).trim()
                            : undefined
                          return (
                            <>
                              <div className="message-pin-surface" {...pinSurfaceProps}>
                                <div
                                  className={`bot-text ${cleanHtml ? 'bot-text-rich' : ''} ${msg.isDecryptionFailure ? 'bubble-failed' : ''}`}
                                  onClick={cleanHtml ? onBotRichTextClick : undefined}
                                >
                                  {msg.threads
                                    ? <div className="msg-threads">{msg.threads.map((t, i) => <ThreadBlock key={i} thread={t} />)}</div>
                                    : msg.cards
                                    ? <div className="msg-cards">
                                        {msg.cards.map((card, ci) => {
                                          const hasActions = card.actions && card.actions.length > 0
                                          const hasFooter = hasActions || !!card.price
                                          const isLinkCard = !hasFooter && !!card.url
                                          const inner = (
                                            <>
                                              {card.image && <img className="msg-card-image" src={card.image} alt="" loading="lazy" />}
                                              <div className="msg-card-body">
                                                <div className="msg-card-title">{card.title}</div>
                                                {card.subtitle && <div className="msg-card-subtitle">{card.subtitle}</div>}
                                                {card.description && <div className="msg-card-description">{card.description}</div>}
                                                {card.fields && card.fields.length > 0 && (
                                                  <dl className="msg-card-fields">
                                                    {card.fields.map((f, fi) => (
                                                      <div key={fi} className="msg-card-field">
                                                        <dt>{f.label}</dt>
                                                        <dd>{f.value}</dd>
                                                      </div>
                                                    ))}
                                                  </dl>
                                                )}
                                              </div>
                                              {hasFooter && (
                                                <div className="msg-card-footer">
                                                  {card.price && <span className="msg-card-price">{card.price}</span>}
                                                  {hasActions && (
                                                    <div className="msg-card-actions">
                                                      {card.actions!.map((a, ai) => (
                                                        <a key={ai} className="msg-card-action" href={a.url} target="_blank" rel="noopener noreferrer">{a.label}</a>
                                                      ))}
                                                    </div>
                                                  )}
                                                </div>
                                              )}
                                            </>
                                          )
                                          return isLinkCard
                                            ? <a key={ci} className="msg-card msg-card-link" href={card.url} target="_blank" rel="noopener noreferrer">{inner}</a>
                                            : <div key={ci} className="msg-card">{inner}</div>
                                        })}
                                      </div>
                                    : imageUrl
                                    ? <img src={imageUrl} alt={msg.body || 'image'} className="msg-image" />
                                    : fileUrl
                                      ? <a href={fileUrl} download={msg.fileName} className="msg-file" target="_blank" rel="noreferrer"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</a>
                                      : msg.fileMxc && !fileUrl
                                        ? <span className="msg-file msg-file-loading"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</span>
                                        : cleanHtml
                                          ? <span dangerouslySetInnerHTML={{ __html: cleanHtml }} />
                                          : text}
                                </div>
                              </div>
                              {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                                <div className="reaction-bar">
                                  {Object.entries(msg.reactions).map(([emoji, senders]) => (
                                    <button
                                      key={emoji}
                                      className={`reaction-btn${senders.includes(userId) ? ' reaction-btn--active' : ''}`}
                                      onClick={() => sendReaction(msg.eventId, emoji)}
                                    >
                                      {emoji}<span className="reaction-count">{senders.length}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
            })}</>
          })()) as React.ReactNode}
          <div ref={bottomRef} />
        </div>
      </div>

      {cameraPrompt && (
        <div className="camera-prompt" onClick={() => { setCameraPrompt(false); cameraInputRef.current?.click() }}>
          <span className="material-icons camera-prompt-icon">photo_camera</span>
          <span className="camera-prompt-label">Tap to open camera</span>
        </div>
      )}

      {messageMenu && (
        <div
          ref={messageMenuRef}
          className="message-ctx-menu"
          style={{ left: messageMenu.x, top: messageMenu.y }}
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="message-ctx-menu-reactions">
            {['✅', '❎'].map(emoji => (
              <button
                key={emoji}
                type="button"
                className="message-ctx-menu-reaction"
                onClick={() => {
                  void sendReaction(messageMenu.eventId, emoji)
                  setMessageMenu(null)
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="message-ctx-menu-item"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard.writeText(messageMenu.body).then(() => showToast('Copied'))
              setMessageMenu(null)
            }}
          >
            Copy
          </button>
          <button
            type="button"
            className="message-ctx-menu-item"
            role="menuitem"
            onClick={() => {
              const room = client.getRoom(roomId)
              const ev = room?.findEventById(messageMenu.eventId)
              if (!ev) { showToast('Event not found'); setMessageMenu(null); return }
              const replacing = (ev as any).replacingEvent?.()
              const payload = {
                eventId: ev.getId(),
                type: ev.getType(),
                sender: ev.getSender(),
                ts: ev.getTs(),
                content: ev.getContent(),
                hasReplacing: !!replacing,
                replacingEventId: replacing?.getId?.(),
                replacingContent: replacing?.getContent?.(),
                replacingNewContent: replacing?.getContent?.()?.['m.new_content'],
              }
              console.log('[inspect event]', payload)
              void navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
                .then(() => showToast('Event JSON copied to clipboard'))
                .catch(() => showToast('Logged to console'))
              setMessageMenu(null)
            }}
          >
            Inspect
          </button>
          <button
            type="button"
            className="message-ctx-menu-item"
            role="menuitem"
            disabled={pinInFlight}
            onClick={() => { void onPinOrUnpin() }}
          >
            {pinnedEventIds.includes(messageMenu.eventId) ? 'Unpin' : 'Pin'}
          </button>
        </div>
      )}

      {showScrollDown && (
        <button
          className="scroll-down-btn"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          style={{ bottom: (footerRef.current?.offsetHeight ?? 80) + 12 }}
        >↓</button>
      )}

      <div className="chat-footer" ref={footerRef}>

        <div className="pills" onWheel={(e) => { const el = e.currentTarget as HTMLDivElement; if (e.deltaY !== 0 && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY }}>
          {lastActions.map((action) => (
            <button key={`action-${action}`} className="pill pill-action" onClick={() => sendMessage(action)}>
              {action}
            </button>
          ))}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={pills} strategy={horizontalListSortingStrategy}>
              {pills.map((pill) => {
                const paramIdx = pill.indexOf('<>')
                const hasParam = paramIdx !== -1
                const onActivate = () => {
                  if (hasParam) {
                    textareaRef.current?.focus()
                    setInput(pill.slice(0, paramIdx))
                  } else {
                    sendMessage(pill)
                  }
                }
                return <SortablePill key={pill} pill={pill} onActivate={onActivate} />
              })}
            </SortableContext>
          </DndContext>
          {addingPill ? (
            <input
              ref={newPillRef}
              className="pill pill-input"
              value={newPillInput}
              onChange={(e) => setNewPillInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const raw = newPillInput.trim()
                  const val = raw.endsWith(':') ? raw.slice(0, -1) + ' <>' : raw
                  if (val && !pills.includes(val)) {
                    const next = [...pills, val]
                    setPills(next)
                    savePills(client, roomId, next)
                  }
                  setNewPillInput('')
                  setAddingPill(false)
                }
                if (e.key === 'Escape') { setAddingPill(false); setNewPillInput('') }
              }}
              onBlur={() => { setAddingPill(false); setNewPillInput('') }}
              placeholder="New reply…"
              enterKeyHint="done"
            />
          ) : (
            <button className="pill pill-add" onClick={() => { setAddingPill(true); setTimeout(() => newPillRef.current?.focus(), 0) }}>
              +
            </button>
          )}
        </div>

        {suggestions.length > 0 && (
          <ul className="autocomplete">
            {suggestions.map((s) => (
              <li key={s} onMouseDown={(e) => { e.preventDefault(); sendMessage(s) }}>
                {s}
              </li>
            ))}
          </ul>
        )}

        {sendError && <div className="send-error">{sendError}</div>}
        {dictationError && <div className="send-error">{dictationError}</div>}
        {pinError && <div className="send-error">{pinError}</div>}

        {showDictation && dictating && (
          <div className="dictation-voice-row" role="status" aria-live="polite">
            <span
              className={
                userSpeaking ? 'dictation-voice-dot dictation-voice-dot--on' : 'dictation-voice-dot'
              }
              aria-hidden
            />
            {dictationAutoSend
              ? (userSpeaking ? 'Hearing' : 'Silence — auto-send on pause')
              : (userSpeaking ? 'Hearing' : 'Silence')}
          </div>
        )}

        <div className="input-row">
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="file-input-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void sendFile(file)
              e.target.value = ''
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="*/*"
            className="file-input-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void sendFile(file)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            title="Attach file or image"
            aria-label="Attach file or image"
          >
            <span className="material-icons" aria-hidden>attach_file</span>
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${e.target.scrollHeight}px`
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Message…"
            enterKeyHint="enter"
            readOnly={dictating}
            aria-readonly={dictating || undefined}
          />
          {showDictation && !input.trim() && (
            <button
              type="button"
              className={
                dictating
                  ? `dictation-btn dictation-btn--on${userSpeaking ? ' dictation-btn--hearing' : ''}`
                  : 'dictation-btn'
              }
              onClick={() => {
                clearDictationError()
                if (dictating) {
                  stopDictation()
                } else {
                  if (!dictationSupported) {
                    setSendError('Dictation is not available in this browser.')
                    setTimeout(() => setSendError(''), 4000)
                    return
                  }
                  startDictation(input, dictationAutoSend ? { autoSend: true } : undefined)
                }
              }}
              disabled={sending}
              title={
                dictating
                  ? 'Stop dictation'
                  : dictationAutoSend
                    ? 'Dictate — auto-send after you pause (toggle in profile menu)'
                    : 'Dictate — send with Send button (enable auto-send in profile menu)'
              }
              aria-label={
                dictating
                  ? 'Stop dictation'
                  : dictationAutoSend
                    ? 'Start dictation with auto-send when done talking'
                    : 'Start dictation; send manually with Send'
              }
            >
              <span className="material-icons" aria-hidden>
                {dictating ? 'stop' : 'mic'}
              </span>
            </button>
          )}
          {(input.trim() || !showDictation) && (
            <button className="send-btn" onClick={() => sendMessage(input)} disabled={sending || !input.trim()}>
              {sending ? '…' : <><span className="send-btn-label">Send</span><span className="send-btn-icon">↑</span></>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function getMaxReadTs(room: sdk.Room, userId: string): number {
  let max = 0
  for (const member of room.getMembers()) {
    if (member.userId === userId || member.membership !== 'join') continue
    const readUpTo = room.getEventReadUpTo(member.userId)
    if (!readUpTo) continue
    const readEvent = room.findEventById(readUpTo)
    if (!readEvent) continue
    const ts = readEvent.getTs()
    if (ts > max) max = ts
  }
  return max
}

function eventToMessage(event: sdk.MatrixEvent, userId: string, maxReadTs: number): Message {
  const isFailure = event.isDecryptionFailure()
  const isEncrypted = event.getType() === 'm.room.encrypted'
  // Resolve the effective content, honoring two edit shapes:
  // 1. This event was edited → use the replacement's m.new_content
  // 2. This event IS the replacement (m.relates_to.rel_type=m.replace) →
  //    use its own m.new_content directly (timeline rendered the edit as
  //    a standalone bubble, e.g. streamed tool-progress updates).
  // Custom fields like com.construct.tool_progress live in m.new_content;
  // without this merge, only the top-level body (with `*` prefix) is read.
  const rawContent = event.getContent() ?? {}
  const replacing = (event as any).replacingEvent?.()
  const isReplacementItself = rawContent?.['m.relates_to']?.rel_type === 'm.replace'
  let content = rawContent
  if (replacing) {
    content = { ...rawContent, ...(replacing.getContent()?.['m.new_content'] ?? {}) }
  } else if (isReplacementItself && rawContent?.['m.new_content']) {
    content = { ...rawContent, ...(rawContent['m.new_content'] as Record<string, unknown>) }
  }
  let body = content?.body ?? ''
  let imageUrl: string | undefined

  if (isFailure || (isEncrypted && !body)) {
    body = '🔒 Unable to decrypt'
  } else if ((content?.msgtype === 'm.image' || content?.msgtype === 'm.file') && content?.url) {
    body = content.body ?? ''
  }

  let formattedBody: string | undefined
  if (!isFailure && content?.format === 'org.matrix.custom.html' && content?.formatted_body) {
    formattedBody = sanitizeHtml(content.formatted_body)
  }

  const isOwnMessage = event.getSender() === userId
  const isRead = isOwnMessage && event.getTs() <= maxReadTs

  const imageMxc = content?.msgtype === 'm.image' && content?.url ? content.url : undefined
  const fileMxc = content?.msgtype === 'm.file' && content?.url ? content.url : undefined
  const fileName = fileMxc ? (content?.body ?? 'file') : undefined
  const fileMime = fileMxc ? (content?.info?.mimetype ?? 'application/octet-stream') : undefined

  const rawCards = content?.['com.construct.cards']
  const cards = Array.isArray(rawCards)
    ? rawCards
        .filter((c: any) => c && typeof c === 'object' && typeof c.title === 'string')
        .map((c: any) => ({
          title: String(c.title),
          subtitle: typeof c.subtitle === 'string' ? c.subtitle : undefined,
          description: typeof c.description === 'string' ? c.description : undefined,
          image: typeof c.image === 'string' ? c.image : undefined,
          fields: Array.isArray(c.fields)
            ? c.fields
                .filter((f: any) => f && typeof f.label === 'string' && typeof f.value === 'string')
                .map((f: any) => ({ label: String(f.label), value: String(f.value) }))
            : undefined,
          price: typeof c.price === 'string' ? c.price : undefined,
          url: typeof c.url === 'string' && /^https?:\/\//.test(c.url) ? c.url : undefined,
          actions: Array.isArray(c.actions)
            ? c.actions
                .filter((a: any) => a && typeof a.label === 'string' && typeof a.url === 'string' && /^https?:\/\//.test(a.url))
                .map((a: any) => ({ label: String(a.label), url: String(a.url) }))
            : undefined,
        }))
    : undefined

  const parseThread = (t: any): ConstructThread | null =>
    t && typeof t === 'object' && typeof t.title === 'string' && typeof t.body === 'string'
      ? { title: String(t.title), summary: typeof t.summary === 'string' ? t.summary : undefined, body: String(t.body) }
      : null
  const rawThreads = content?.['com.construct.threads'] ?? content?.['com.construct.thread']
  const threads = Array.isArray(rawThreads)
    ? (rawThreads.map(parseThread).filter(Boolean) as ConstructThread[])
    : rawThreads ? ([parseThread(rawThreads)].filter(Boolean) as ConstructThread[]) : undefined

  const rawToolProgress = content?.['com.construct.tool_progress']
  const toolProgress: ToolProgressLine[] | undefined = Array.isArray(rawToolProgress)
    ? rawToolProgress
        .filter((l: any) => l && typeof l.emoji === 'string' && typeof l.tool === 'string')
        .map((l: any) => ({
          emoji: String(l.emoji),
          tool: String(l.tool),
          content: typeof l.content === 'string' ? l.content : undefined,
          repeat: typeof l.repeat === 'number' ? l.repeat : undefined,
          raw: `${l.emoji} ${l.tool}${l.content ? `: "${l.content}"` : '...'}`,
        }))
    : undefined

  const source = typeof content?.['com.construct.source'] === 'string'
    ? String(content['com.construct.source'])
    : undefined

  return {
    eventId: event.getId() ?? event.getTs().toString(),
    sender: event.getSender() ?? '',
    body,
    formattedBody,
    imageUrl,
    imageMxc,
    fileMxc,
    fileName,
    fileMime,
    cards: cards && cards.length > 0 ? cards : undefined,
    threads: threads && threads.length > 0 ? threads : undefined,
    toolProgress: toolProgress && toolProgress.length > 0 ? toolProgress : undefined,
    timestamp: event.getTs(),
    isOwnMessage,
    isDecryptionFailure: isFailure,
    isRead,
    source,
  }
}

function buildReactionsMap(events: sdk.MatrixEvent[]): Record<string, Record<string, string[]>> {
  const map: Record<string, Record<string, string[]>> = {}
  for (const e of events) {
    if (e.getType() !== 'm.reaction') continue
    const rel = e.getContent()['m.relates_to']
    if (!rel || rel.rel_type !== 'm.annotation') continue
    const targetId = rel.event_id as string
    const emoji = rel.key as string
    const sender = e.getSender() ?? ''
    if (!map[targetId]) map[targetId] = {}
    if (!map[targetId][emoji]) map[targetId][emoji] = []
    if (!map[targetId][emoji].includes(sender)) map[targetId][emoji].push(sender)
  }
  return map
}

function eventsToMessages(events: sdk.MatrixEvent[], userId: string, room: sdk.Room): Message[] {
  const maxReadTs = getMaxReadTs(room, userId)
  const reactionsMap = buildReactionsMap(events)
  const messageEvents = events
    .filter((e) => e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted' || e.isDecryptionFailure())
  // Fold m.replace edits into their target: render the newest edit's
  // content inside the target bubble and hide the edit events themselves.
  // Edits whose target sits outside the loaded window keep the newest
  // edit as a standalone bubble so the content isn't lost.
  const presentIds = new Set(messageEvents.map((e) => e.getId() ?? ''))
  const latestEditByTarget = new Map<string, sdk.MatrixEvent>()
  for (const e of messageEvents) {
    const rel = e.getRelation()
    if (rel?.rel_type === 'm.replace' && rel.event_id) latestEditByTarget.set(rel.event_id, e)
  }
  const standaloneEditIds = new Set(
    [...latestEditByTarget.entries()]
      .filter(([targetId]) => !presentIds.has(targetId))
      .map(([, e]) => e.getId() ?? '')
  )
  return messageEvents
    .filter((e) => {
      const rel = e.getRelation()
      if (rel?.rel_type !== 'm.replace' || !rel.event_id) return true
      return standaloneEditIds.has(e.getId() ?? '')
    })
    .map((e) => {
      const id = e.getId() ?? ''
      const edit = latestEditByTarget.get(id)
      let msg = eventToMessage(edit ?? e, userId, maxReadTs)
      if (edit) msg = { ...msg, eventId: id, timestamp: e.getTs() }
      const reactions = reactionsMap[msg.eventId]
      return reactions ? { ...msg, reactions } : msg
    })
}

const ALLOWED_TAGS = /^(p|br|strong|b|em|i|u|s|del|code|pre|ul|ol|li|blockquote|h[1-6]|a|span)$/i
const ALLOWED_ATTRS: Record<string, string[]> = { a: ['href', 'target', 'rel'] }

function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  function clean(node: Node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      if (!ALLOWED_TAGS.test(el.tagName)) {
        el.replaceWith(...Array.from(el.childNodes))
        return
      }
      const allowed = ALLOWED_ATTRS[el.tagName.toLowerCase()] ?? []
      for (const attr of Array.from(el.attributes)) {
        if (!allowed.includes(attr.name)) el.removeAttribute(attr.name)
      }
      if (el.tagName.toLowerCase() === 'a') {
        const href = el.getAttribute('href') ?? ''
        if (href.startsWith('javascript:')) el.removeAttribute('href')
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      }
      Array.from(el.childNodes).forEach(clean)
    }
  }
  Array.from(doc.body.childNodes).forEach(clean)
  return doc.body.innerHTML
}

function shortName(userId: string): string {
  return userId.replace(/^@/, '').split(':')[0]
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a), db = new Date(b)
  return da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

// Memoized so that when RoomsLayout re-renders (e.g. on navigation),
// the 1..N mounted ChatViews don't all re-render their entire message
// lists synchronously. That reconciliation was causing a ~1s main-thread
// stall on mobile when returning to the rooms screen.
export default memo(ChatView)
