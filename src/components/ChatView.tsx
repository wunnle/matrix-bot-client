import React from 'react'
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type CSSProperties,
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
import { getRoomOwners } from '../lib/roomOwners'
import { pinRoomEvent, unpinRoomEvent } from '../lib/pinRoomMessage'
import { loadPills, savePills, isAgentRoom, agentRoomModels } from '../lib/roomMeta'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { Capacitor } from '@capacitor/core'
import { isMobileSafari } from '../lib/isMobileSafari'
import { actionLabel, isActionPlaceholder, parseActions } from '../lib/actions'
import { formatModel } from '../lib/modelLabel'
import { useSpeechDictation } from '../hooks/useSpeechDictation'
import { useToast } from '../hooks/useToast'
import { useVisualViewportResize } from '../hooks/useVisualViewport'
import RoomEditor from './RoomEditor'
import { HeaderUsageBar } from './PlanUsageMeter'
import { usePlanUsage, useCodexUsage } from '../hooks/usePlanUsage'
import { Marked } from 'marked'
import type { Message, RoomConfig, ConstructThread, ConstructApproval, ToolProgressLine } from '../types'
import { useAgentRun, type AgentRun } from '../hooks/useAgentActivity'
import { AgentActivityBar } from './AgentActivityBar'
import MessageActionSheet from './MessageActionSheet'
import ApprovalBar from './ApprovalBar'
import ModelMenu from './ModelMenu'
import { approvalChoices, parseApprovalCard } from '../lib/approval'
import { currentLocation, extractLocationBlocks, formatCoords, locationContent, locationFromContent, mapsUrl, mapTiles, MAP_ATTRIBUTION } from '../lib/location'
import { hapticPress, hapticSend, hapticSuccess, hapticTick, hapticWarning } from '../lib/haptics'
import { useAgentBlocked, formatResetsAt, blockedHeadline } from '../hooks/useAgentBlocked'

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
// How long a room with nothing cached waits on the server before the spinner
// gives way to a retry. /messages has no timeout of its own.
const INITIAL_LOAD_TIMEOUT_MS = 8000

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

// Only the room's own bot gets its tool progress collapsed into a chip. A peer
// agent's progress lines stay attributed to them rather than folding into this
// room's bot narration.
function isBotToolProgress(msg: Message): boolean {
  return !msg.isOwnMessage && !msg.isPeerMessage && isToolProgressMessage(msg.body, msg)
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

// Thread bodies are parsed here rather than arriving as HTML, so the diff and
// command renderers have to be repeated client-side — otherwise the full change
// behind an approval card would render as a flat, uncoloured block.
function escapeCode(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const threadMd = new Marked({
  renderer: {
    code(token: { lang?: string; text: string }) {
      if (token.lang === 'cmd') return `<pre><code class="cmd">${escapeCode(token.text)}</code></pre>`
      if (token.lang !== 'diff') return false
      const lines = token.text.split('\n').map((line) => {
        const cls = line.startsWith('+') ? 'diff-add'
          : line.startsWith('-') ? 'diff-del'
          : line.startsWith('#') ? 'diff-meta'
          : 'diff-ctx'
        const marked_ = cls !== 'diff-ctx'
        const mark = marked_ ? escapeCode(line[0]) : ''
        const rest = escapeCode(marked_ ? line.slice(1) : line) || '&nbsp;'
        return `<span class="${cls}"><span class="diff-mark">${mark}</span>${rest}</span>`
      })
      return `<pre><code class="diff">${lines.join('')}</code></pre>`
    },
  },
} as any)

function ThreadBlock({ thread }: { thread: ConstructThread }) {
  const [expanded, setExpanded] = React.useState(false)
  const bodyHtml = React.useMemo(
    () => sanitizeHtml(threadMd.parse(thread.body, { async: false }) as string),
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

// A bot's model picker: the agent bot's answer to !model ("Model: …" +
// [[!model <id>]]) or Hermes' to !switch ("Pick model:" + [[/luna]]).
function isModelPicker(m: Message): boolean {
  if (m.isOwnMessage) return false
  const { actions } = parseActions(m.body)
  if (!actions.length) return false
  if (/^\s*Model:/.test(m.body)) return actions.every((a) => /^!model\s+\S+$/.test(a))
  if (/^\s*Pick model:/i.test(m.body)) return actions.every((a) => /^\/\w+$/.test(a))
  return false
}

// The ask and the answer of a model picker, which the header's model menu
// stands in for. The pick and the bot's confirmation stay, as the record.
function isModelPickerTraffic(m: Message): boolean {
  return (m.isOwnMessage && /^!(model|switch)$/.test(m.body.trim())) || isModelPicker(m)
}

// Agent room topics are ` · `-separated, and their first field is where the
// room works: an absolute path for a plain room, a branch name for one running
// in its own worktree. A full path never fits the subtitle line, so keep only
// its last segment — the directory or worktree name is what identifies it.
// Branches pass through untouched, being short and already meaningful.
function shortenTopicPaths(topic: string): string {
  return topic
    .split(' · ')
    .map((part) => (part.startsWith('/') ? part.split('/').filter(Boolean).pop() ?? part : part))
    .join(' · ')
}

/**
 * Scroll a container to its true end.
 *
 * scrollIntoView on the bottom sentinel aligns that zero-height div, which
 * leaves whatever sits below it — a collapsed bottom margin on the last block,
 * the container's own padding — still scrollable, so entering a room landed a
 * few pixels short. The arithmetic has no such gap.
 */
function scrollToEnd(el: HTMLElement | null, behavior: ScrollBehavior = 'instant') {
  if (!el) return
  el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior })
}

// The scrollbar lives inside the block's border box but outside its client
// box, so a hit below/right of the client box is the bar, not the code.
const isOnScrollbar = (block: HTMLElement, e: { clientX: number; clientY: number }) => {
  const rect = block.getBoundingClientRect()
  return (
    e.clientY >= rect.top + block.clientTop + block.clientHeight ||
    e.clientX >= rect.left + block.clientLeft + block.clientWidth
  )
}

function ChatView({ roomId, isActive, roomName, config, userId, onBack, dictationAutoSend }: Props) {
  // Read inside the timeline listener, which must not re-subscribe whenever
  // the active room changes.
  const isActiveRef = useRef(isActive)
  useEffect(() => { isActiveRef.current = isActive }, [isActive])

  // Keyboard show/hide resizes the layout; keep the tail visible, but only
  // if the user was already at the bottom — never yank them out of history.
  useVisualViewportResize(() => {
    if (!stickToBottomRef.current) return
    programmaticScrollUntilRef.current = performance.now() + 100
    scrollToEnd(messagesRef.current)
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

  // A drag is not a tap. Scrolling a code block sideways ends in a click on
  // it, which would otherwise copy the block and pop a toast on every swipe.
  const richTextPointerRef = useRef<{ x: number; y: number; pre: HTMLElement | null; scrollLeft: number } | null>(null)
  // A native scrollbar drag dies the instant its element is replaced, and every
  // timeline re-render rebuilds the <pre>. Dragging the thumb towards the edge
  // of the block makes WebKit autoscroll the message list, which is a scroll on
  // the container itself — past the nested-scroller guard in handleScroll — and
  // near the top that kicks off scrollback. So: hold the timeline still for as
  // long as the thumb is held.
  const scrollbarDragRef = useRef(false)
  const onBotRichTextPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target
    const pre = target instanceof Element ? (target.closest('pre') as HTMLElement | null) : null
    richTextPointerRef.current = { x: e.clientX, y: e.clientY, pre, scrollLeft: pre?.scrollLeft ?? 0 }
    if (pre && isOnScrollbar(pre, e)) {
      scrollbarDragRef.current = true
      const end = () => {
        scrollbarDragRef.current = false
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
      }
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    }
  }, [])


  const onBotRichTextClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const start = richTextPointerRef.current
    richTextPointerRef.current = null
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return
    // Dragging the thumb back to roughly where you grabbed it, or clicking the
    // track to page sideways, both stay under the move threshold but are plainly
    // not a tap on the code.
    if (start?.pre && start.pre.scrollLeft !== start.scrollLeft) return
    if (start?.pre && isOnScrollbar(start.pre, { clientX: start.x, clientY: start.y })) return
    const raw = e.target
    if (raw == null || !(raw instanceof Element)) return
    if (raw.closest('a')) return
    const code = raw.closest('code')
    const block: HTMLElement | null = (code as HTMLElement) ?? (raw.closest('pre') as HTMLElement | null)
    if (!block) return
    const pre = block.closest('pre')
    if (pre instanceof HTMLElement && isOnScrollbar(pre, e)) return
    e.preventDefault()
    const text = block.textContent ?? ''
    void copyTextToClipboard(text).then(() => showToast('Copied'))
  }, [showToast])

  // Action pills reflect the last message only: once you reply (or the bot
  // says anything after), the previous message's [[buttons]] should clear.
  // Tool lines and mid-turn narration don't count as "saying anything" — the
  // bot keeps posting those while an approval card waits on you, and letting
  // them win took the Approve / Deny pills away the moment one landed.
  const lastActionMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (isBotToolProgress(m) || (m.interim && !m.isOwnMessage && !m.isPeerMessage)) continue
      return m.isOwnMessage ? null : m
    }
    return null
  }, [messages])
  const lastActions = useMemo(
    () => (lastActionMessage ? parseActions(lastActionMessage.body).actions : []),
    [lastActionMessage],
  )
  // That message, when it is an approval card: it gets the approval bar in
  // place of the pill row.
  const pendingApproval = useMemo(() => {
    if (!lastActionMessage) return null
    const { approve, deny, always, session, auto } = approvalChoices(lastActions)
    const card = approve ? parseApprovalCard(lastActionMessage.body) : null
    if (!approve || !card) return null
    return { msg: lastActionMessage, card, approve, deny, always, session, auto }
  }, [lastActionMessage, lastActions])
  // That message, when it is a model picker — the agent bot's answer to !model
  // ("Model: …" + [[!model <id>]]) or Hermes' to !switch ("Pick model:" +
  // [[/luna]]): the model menu lists its options, and the timeline hides it.
  const modelPicker = useMemo(
    () => (lastActionMessage && isModelPicker(lastActionMessage) ? { msg: lastActionMessage, options: lastActions } : null),
    [lastActionMessage, lastActions],
  )
  // The header chip's dropdown, holding the command it sent. It opens at once
  // and loads for as long as that command is still the last word.
  const [modelMenuRequest, setModelMenuRequest] = useState<string | null>(null)
  const modelMenuLoading = !!modelMenuRequest && !lastActionMessage &&
    messages.findLast((m) => m.isOwnMessage)?.body === modelMenuRequest
  // Agent rooms list their models in room state, so their menu opens with
  // them straight away and nothing is sent until you pick.
  const [modelMenuOptions, setModelMenuOptions] = useState<string[] | null>(null)
  // A picker asked for some other way — the !model pill, typing it — opens
  // the menu too, since the timeline no longer shows it. Only one that lands
  // while the room is open, so an old one doesn't pop up on entering.
  const [openedAt] = useState(() => Date.now())
  const [dismissedPickerId, setDismissedPickerId] = useState<string | null>(null)
  const showModelMenu = !!modelMenuOptions || !!modelMenuRequest ||
    (!!modelPicker && modelPicker.msg.timestamp >= openedAt && modelPicker.msg.eventId !== dismissedPickerId)
  const closeModelMenu = () => {
    setModelMenuOptions(null)
    setModelMenuRequest(null)
    if (modelPicker) setDismissedPickerId(modelPicker.msg.eventId)
  }
  const [addingPill, setAddingPill] = useState(false)
  const [newPillInput, setNewPillInput] = useState('')
  const newPillRef = useRef<HTMLInputElement>(null)
  // The pill row. A tapped pill sends it back to its start, so the action
  // pills and the first saved ones are in reach for the next tap.
  const pillsRowRef = useRef<HTMLDivElement>(null)
  const resetPillsScroll = () => pillsRowRef.current?.scrollTo({ left: 0, behavior: 'smooth' })
  const [sending, setSending] = useState(false)
  // Waiting on a location fix, which can take seconds; the paperclip spins meanwhile.
  const [locating, setLocating] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const retryInitialLoadRef = useRef<() => void>(() => {})
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [renderStart, setRenderStart] = useState(0)
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const [bot, setBot] = useState<{ name: string; avatarUrl: string | null } | null>(null)
  const [roomAvatarUrl, setRoomAvatarUrl] = useState<string | null>(null)
  const [roomTopic, setRoomTopic] = useState('')
  const [sendError, setSendError] = useState('')
  const [pinError, setPinError] = useState('')
  const [pinInFlight, setPinInFlight] = useState(false)
  // Touch only: the message whose action sheet a long-press opened. Hover
  // devices use the inline meta row instead.
  const [actionSheetId, setActionSheetId] = useState<string | null>(null)
  const closeActionSheet = useCallback(() => setActionSheetId(null), [])
  const [showScrollDown, setShowScrollDown] = useState(false)
  const footerRef = useRef<HTMLDivElement>(null)
  // The footer floats over the end of the list (the composer is glass), so the
  // list pads its end by the footer's height — which pills, the activity row
  // and a growing textarea all change. Stay pinned to the end if you were there.
  useLayoutEffect(() => {
    const footer = footerRef.current
    if (!footer) return
    const apply = () => {
      // A hidden (display:none) room measures 0; scrolling it would throw away
      // its position for when it is shown again.
      if (footer.offsetHeight === 0) return
      const list = messagesRef.current
      const atEnd = !!list && list.scrollHeight - list.scrollTop - list.clientHeight < 150
      footer.parentElement?.style.setProperty('--footer-h', `${footer.offsetHeight}px`)
      if (atEnd) scrollToEnd(list)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(footer)
    return () => observer.disconnect()
  }, [])
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const [pinnedEventIds, setPinnedEventIds] = useState<string[]>([])
  const [pinnedDisplay, setPinnedDisplay] = useState<Message[]>([])
  const [pinnedExpanded, setPinnedExpanded] = useState(true)

  const client = getClient()
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const codeScrollRef = useRef(new Map<string, number>())
  const refreshPinnedRef = useRef<() => void>(() => {})
  const pinnedIdsRef = useRef<Set<string>>(new Set())
  const activeRoomIdRef = useRef(roomId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  // A pasted, dropped or picked file waits here until Send, so it can go out
  // with whatever is typed as its caption. previewUrl is set for images only.
  const [pending, setPending] = useState<{ file: File, previewUrl?: string } | null>(null)
  // Which room the paperclip menu was opened in, so switching rooms closes it.
  const [attachMenuRoom, setAttachMenuRoom] = useState<string | null>(null)
  const attachMenuOpen = attachMenuRoom === roomId
  const autoSendToMessage = useRef<((t: string) => void) | null>(null)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)

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
      resolved.push(eventToMessage(ev, userId, maxReadTs, room))
    }
    setPinnedDisplay(resolved)
  }, [client, roomId, userId])

  useEffect(() => {
    refreshPinnedRef.current = () => {
      void refreshPinned()
    }
  }, [refreshPinned])

  // Model-picker traffic is the header menu's business, not the timeline's.
  const visibleMessages = useMemo(
    () => (renderStart > 0 ? messages.slice(renderStart) : messages).filter((m) => !isModelPickerTraffic(m)),
    [messages, renderStart],
  )

  // Tool group IDs: each tool message maps to the eventId its group starts at,
  // and a group is "collapsible" once something non-tool follows it (i.e. the
  // run moved on). Derived from the message list alone, so it is memoised
  // rather than recomputed inside the render.
  const toolGroups = useMemo(() => {
    const toolGroupId: Record<string, string> = {}
    const collapsibleGroups = new Set<string>()
    let currentGroupStart = ''
    for (let i = 0; i < visibleMessages.length; i++) {
      const m = visibleMessages[i]
      const p = i > 0 ? visibleMessages[i - 1] : null
      const n = i + 1 < visibleMessages.length ? visibleMessages[i + 1] : null
      const iT = isBotToolProgress(m)
      if (!iT) continue
      const pT = p && isBotToolProgress(p)
      const nT = n && isBotToolProgress(n)
      if (!pT) currentGroupStart = m.eventId
      toolGroupId[m.eventId] = currentGroupStart
      if (!nT && n !== null) collapsibleGroups.add(currentGroupStart)
    }
    return { toolGroupId, collapsibleGroups }
  }, [visibleMessages])

  // What the bot looks like it's doing, for the status row above the composer.
  // Any typing member counts as "the run is alive": the room's bot isn't
  // separable from a peer by user id here (getRoomBotMeta only takes the first
  // other member), and a peer typing only keeps the row up a little longer.
  const agentRun = useAgentRun(messages)
  // Only whether the strip is showing, not its ticking contents — the clock
  // lives in AgentActivityBar so a tick doesn't repaint the timeline.
  const [agentActivity, setAgentActivity] = useState(false)
  useEffect(() => {
    if (!agentRun) setAgentActivity(false)
  }, [agentRun])

  // Set by the bot when a turn came back "usage limit reached" — the one state
  // where the room is alive but nothing the user types will run.
  const agentBlocked = useAgentBlocked(client, roomId)

  // Feel it when the agent you're watching finishes or gets stuck. Only for the
  // room on screen, and not in the first moments after it comes on screen:
  // opening a room settles its run and blocked state from history, and that
  // settling is not news.
  const hapticsArmedAtRef = useRef(0)
  useEffect(() => { if (isActive) hapticsArmedAtRef.current = Date.now() + 1500 }, [isActive])
  const watching = useCallback(() =>
    isActiveRef.current &&
    document.visibilityState === 'visible' &&
    Date.now() > hapticsArmedAtRef.current, [])
  const hadRunRef = useRef(false)
  useEffect(() => {
    const hadRun = hadRunRef.current
    hadRunRef.current = agentRun !== null
    // A run ends only when the bot's reply lands (see useAgentRun).
    if (hadRun && !agentRun && watching()) hapticSuccess()
  }, [agentRun, watching])
  const wasBlockedRef = useRef(false)
  useEffect(() => {
    const wasBlocked = wasBlockedRef.current
    wasBlockedRef.current = agentBlocked !== null
    if (!wasBlocked && agentBlocked && watching()) hapticWarning()
  }, [agentBlocked, watching])

  useEffect(() => {
    isFirstLoad.current = true
    stickToBottomRef.current = true
    lastTailEventIdRef.current = undefined
    setHasMore(true)
    setMessages([])
    setRenderStart(0)
    setInitializing(true)
    setLoadError(false)
    resolvedImagesRef.current = new Set()
    setImageUrls({})
    setCurrentModel(getRoomModel(roomId))

    let disposed = false
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined

    // The listener below only sees events that arrive while the room is open,
    // so a room opened cold showed no model until the bot happened to reply
    // again. Recover it from the most recent tagged message already loaded.
    const harvestModel = (events: sdk.MatrixEvent[]) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev.getSender() === userId) continue
        const tagged = ev.getContent()?.['com.construct.model']
        if (typeof tagged === 'string' && tagged) {
          setRoomModel(roomId, tagged)
          setCurrentModel(tagged)
          return
        }
      }
    }

    // Block rendering until we have a stable first batch to avoid jump cascades.
    const populate = (msgs: ReturnType<typeof eventsToMessages>) => {
      setMessages(msgs)
      setInitializing(false)
    }

    // Nothing cached, so the first screen has to come from the server. After
    // iOS suspends the app that request can sit on a dead socket for a long
    // time: stop spinning after a while and offer a retry, but still take the
    // result if it lands late.
    const fetchInitial = (room: sdk.Room) => {
      setLoadError(false)
      clearTimeout(giveUpTimer)
      giveUpTimer = setTimeout(() => { if (!disposed) setLoadError(true) }, INITIAL_LOAD_TIMEOUT_MS)
      client.scrollback(room, 20)
        .then(() => {
          if (disposed) return
          clearTimeout(giveUpTimer)
          setLoadError(false)
          if (room.oldState.paginationToken === null) setHasMore(false)
          const events = room.getLiveTimeline().getEvents()
          harvestModel(events)
          populate(eventsToMessages(events, userId, room))
        })
        .catch(() => {
          if (disposed) return
          clearTimeout(giveUpTimer)
          setLoadError(true)
        })
    }

    // Some history is cached but not a full screen of it — common after a
    // limited sync on resume. Show what we have now and fetch the rest behind
    // it, rather than holding the whole room on the network.
    const topUp = (room: sdk.Room) => {
      client.scrollback(room, 20)
        .then(() => {
          if (disposed) return
          if (room.oldState.paginationToken === null) setHasMore(false)
          const container = messagesRef.current
          if (container && !stickToBottomRef.current) {
             
            scrollAnchorRef.current = container.scrollHeight - container.scrollTop
          }
          setMessages(eventsToMessages(room.getLiveTimeline().getEvents(), userId, room))
        })
        .catch(() => {}) // the cached messages are up; scrolling up retries
    }

    const loadInitial = (room: sdk.Room) => {
      const existing = room.getLiveTimeline().getEvents()
      const cached = eventsToMessages(existing, userId, room)
      if (cached.length > 0) {
        harvestModel(existing)
        populate(cached)
        if (existing.length < 20) topUp(room)
      } else {
        fetchInitial(room)
      }
      // Send read receipt when opening room
      client.sendReadReceipt(room.getLiveTimeline().getEvents().at(-1) ?? null)
        .catch(() => {})
    }

    retryInitialLoadRef.current = () => {
      const room = client.getRoom(roomId)
      if (room) fetchInitial(room)
    }

    // Opened before the client knows the room — a deep link or notification
    // tap racing the first sync, or a room made on another device. Load it
    // the moment it arrives instead of spinning forever.
    const onRoom = (room: sdk.Room) => {
      if (room.roomId !== roomId) return
      client.off(sdk.ClientEvent.Room, onRoom)
      loadInitial(room)
    }
    const room = client.getRoom(roomId)
    if (room) loadInitial(room)
    else client.on(sdk.ClientEvent.Room, onRoom)

    const onEvent = (event: sdk.MatrixEvent, room_: sdk.Room | undefined) => {
      if (room_?.roomId !== roomId) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return
      const maxReadTs = getMaxReadTs(room_, userId)
      const msg = eventToMessage(event, userId, maxReadTs, room_)
      if (!msg.isOwnMessage) {
        const content = event.getContent()
        const eventModel: string | undefined = content['com.construct.model']
        if (eventModel) {
          setRoomModel(roomId, eventModel)
          setCurrentModel(eventModel)
        }
        // A receipt is otherwise only sent when the room is opened, so anything
        // arriving while you are sitting in the room stayed unread forever and
        // the badge climbed. Agent rooms hit this constantly: the bot replies
        // while you watch.
        if (isActiveRef.current && document.visibilityState === 'visible') {
          client.sendReadReceipt(event).catch(() => {})
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

    // Re-render message when decryption completes late
    const onDecrypted = (event: sdk.MatrixEvent) => {
      if (event.getRoomId() !== roomId) return
      if (event.isDecryptionFailure()) {
        // Try to fetch missing keys from key backup
        client.getCrypto()?.checkKeyBackupAndEnable().catch(() => {})
      }
      const room_ = client.getRoom(roomId)
      // History loaded before decryption finished carries no readable tag, so
      // pick the model up here once the content is actually available.
      if (event.getSender() !== userId) {
        const tagged = event.getContent()?.['com.construct.model']
        if (typeof tagged === 'string' && tagged) {
          setRoomModel(roomId, tagged)
          setCurrentModel(tagged)
        }
      }
      const maxReadTs = room_ ? getMaxReadTs(room_, userId) : 0
      const decrypted = eventToMessage(event, userId, maxReadTs, room_ ?? undefined)
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
      disposed = true
      clearTimeout(giveUpTimer)
      client.off(sdk.ClientEvent.Room, onRoom)
      client.off(sdk.RoomEvent.Timeline, onTimeline)
      client.off(sdk.MatrixEventEvent.Decrypted, onDecrypted)
      client.off(sdk.RoomEvent.Receipt, onReceipt)
    }
  }, [roomId, userId, client])

  // A failed first load retries by itself once there is reason to think it
  // would now work: the app is back in front, or sync has just recovered.
  useEffect(() => {
    if (!loadError) return
    const retry = () => {
      if (document.visibilityState === 'visible') retryInitialLoadRef.current()
    }
    const onSync = (state: string, prev: string | null) => {
      if (state === 'SYNCING' && prev !== 'SYNCING') retry()
    }
    document.addEventListener('visibilitychange', retry)
    client.on(sdk.ClientEvent.Sync, onSync)
    return () => {
      document.removeEventListener('visibilitychange', retry)
      client.off(sdk.ClientEvent.Sync, onSync)
    }
  }, [loadError, client])

  // Mark the room read whenever it's actually in front of you: on becoming the
  // active room and on the app coming back to the foreground. The receipt in
  // the effect above only runs on first mount, but ChatViews stay mounted once
  // visited, so reopening a room — or unlocking the phone onto it — sent
  // nothing. The room list showed 0 locally while the server kept the old
  // receipt: the badge came back on the next message, and never cleared on the
  // other device.
  useEffect(() => {
    if (!isActive) return
    const markRead = () => {
      if (document.visibilityState !== 'visible') return
      const room = client.getRoom(roomId)
      // Skip local echoes: a receipt needs a server event id.
      const last = room?.getLiveTimeline().getEvents().findLast((e) => e.getId()?.startsWith('$'))
      if (!last || room?.hasUserReadEvent(userId, last.getId()!)) return
      client.sendReadReceipt(last).catch(() => {})
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => document.removeEventListener('visibilitychange', markRead)
  }, [isActive, roomId, userId, client])

  // Last resort for the model tag. In an encrypted room, history is often
  // decrypted during sync before this component mounts, so the Decrypted
  // listener never fires for it and the open-time scan sees only ciphertext.
  // Deriving from the rendered list re-runs on every update, so it does not
  // depend on catching any particular event at the right moment.
  const scannedModel = useMemo(() => {
    const room = client.getRoom(roomId)
    if (!room) return null
    const events = room.getLiveTimeline().getEvents()
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.getSender() === userId) continue
      const tagged = ev.getContent()?.['com.construct.model']
      if (typeof tagged === 'string' && tagged) return tagged
    }
    return null
  }, [messages, roomId, userId])

  const shownModel = currentModel ?? scannedModel
  // A plan quota only means something in a room that spends it. A freshly
  // spawned agent room has no tagged reply yet, but the bot wrote its model
  // into the topic ("<branch> · <model>"), so that stands in until one lands.
  const topicModel = !shownModel && isAgentRoom(client, roomId)
    ? roomTopic.split(' · ').pop()?.trim() || null
    : null
  const usageModel = shownModel ?? topicModel
  const isClaudeRoom = !!usageModel && /claude|opus|sonnet|haiku|fable/i.test(usageModel)
  const isCodexRoom = !!usageModel && /gpt|codex/i.test(usageModel)
  const planUsage = usePlanUsage(isClaudeRoom ? client : null)
  const codexUsage = useCodexUsage(isCodexRoom ? client : null)

  useEffect(() => {
    if (scannedModel) setRoomModel(roomId, scannedModel)
  }, [scannedModel, roomId])

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
    // On the room, not room.currentState — see useAgentBlocked for why.
    room.on(sdk.RoomStateEvent.Members, onMembers)
    room.on(sdk.RoomEvent.CurrentStateUpdated, update)
    return () => {
      cancelled = true
      room.off(sdk.RoomStateEvent.Members, onMembers)
      room.off(sdk.RoomEvent.CurrentStateUpdated, update)
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
      setRoomTopic(shortenTopicPaths(t))
    }
    readTopic()
    const onState = (ev: sdk.MatrixEvent) => {
      if (ev.getRoomId() !== roomId) return
      if (ev.getType() === sdk.EventType.RoomTopic) readTopic()
    }
    room.on(sdk.RoomStateEvent.Events, onState)
    room.on(sdk.RoomEvent.CurrentStateUpdated, readTopic)
    return () => {
      room.off(sdk.RoomStateEvent.Events, onState)
      room.off(sdk.RoomEvent.CurrentStateUpdated, readTopic)
    }
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
  const [toolDialog, setToolDialog] = useState<{ lines: ReturnType<typeof parseToolProgressMessage> } | null>(null)
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null)
  const [approvalDialog, setApprovalDialog] = useState<ConstructApproval | null>(null)
  const [expandedToolLine, setExpandedToolLine] = useState<string | null>(null)
  const resolvedImagesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])
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
    const onSwap = () => refreshPinned()
    room.on(sdk.RoomStateEvent.Events, onState)
    room.on(sdk.RoomEvent.CurrentStateUpdated, onSwap)
    return () => {
      room.off(sdk.RoomStateEvent.Events, onState)
      room.off(sdk.RoomEvent.CurrentStateUpdated, onSwap)
    }
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
  // Last scrollTop seen while the room was visible. A display:none list can
  // report (or clamp to) 0, so read the position from here when it is shown again.
  const lastScrollTopRef = useRef(0)
  // Until then, your own new message doesn't pull the list to the end. Set by
  // quick-command sends; see sendMessage.
  const quietSendUntilRef = useRef(0)

  // Content that grows without a new message — the run's live step appearing
  // under its tool history, an image finishing its load — would otherwise
  // slide the end of the chat under the composer. Follow it if you were there.
  useLayoutEffect(() => {
    const inner = messagesRef.current?.firstElementChild
    if (!inner) return
    const observer = new ResizeObserver(() => {
      const list = messagesRef.current
      if (!list || list.offsetHeight === 0) return
      if (stickToBottomRef.current && !loadingMoreRef.current) scrollToEnd(list)
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  // When this room is shown again, its ChatView was only hidden (display)
  // but kept state. If you had scrolled up into the history, put you back
  // where you were. If you were at the end, reset to the tail and pin to
  // bottom, so whatever arrived while you were away is on screen.
  useLayoutEffect(() => {
    /* eslint-disable react-hooks/immutability, react-hooks/set-state-in-effect -- must sync refs + renderStart before the visible-messages useLayoutEffect in the same commit */
    if (!isActive) {
      wasActiveRef.current = false
      return
    }
    const justBecameActive = !wasActiveRef.current
    wasActiveRef.current = true
    if (!justBecameActive) return
    // First activation mounts pinned, so this only fires on a return visit.
    if (!stickToBottomRef.current) {
      const container = messagesRef.current
      if (container) {
        programmaticScrollUntilRef.current = performance.now() + 200
        container.scrollTop = lastScrollTopRef.current
      }
      setShowScrollDown(true)
      return
    }
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
        scrollToEnd(messagesRef.current)
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
    const ownSend = tailChanged && tail.isOwnMessage && performance.now() >= quietSendUntilRef.current
    const shouldScroll = (stickToBottomRef.current || ownSend) && !loadingMoreRef.current
    if (!shouldScroll) return
    const behavior: ScrollBehavior = (!isFirstLoad.current && tailChanged && tail.isOwnMessage) ? 'smooth' : 'instant'
    isFirstLoad.current = false
    programmaticScrollUntilRef.current = performance.now() + (behavior === 'smooth' ? 500 : 100)
    scrollToEnd(messagesRef.current, behavior)
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
    scrollToEnd(messagesRef.current)
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
  // How far a code block is scrolled sideways is state the DOM does not keep
  // for us. Any render that replaces a message's markup — a streamed edit, an
  // image URL resolving, the render window sliding — builds a fresh <pre>,
  // and a fresh <pre> starts back at the left. Remember the offset per block
  // and put it back whenever the timeline's DOM changes underneath it.
  useEffect(() => {
    const container = messagesRef.current
    if (!container) return

    // Identify a block by the message it belongs to rather than by element
    // identity, which is exactly what gets thrown away on a re-render.
    const keyFor = (pre: Element): string | null => {
      const message = pre.closest('[data-event-id]')
      const eventId = message instanceof HTMLElement ? message.dataset.eventId : undefined
      if (!eventId) return null
      const index = Array.prototype.indexOf.call(message!.querySelectorAll('pre'), pre)
      return index < 0 ? null : `${eventId}:${index}`
    }

    // 'scroll' does not bubble, so catch the blocks' own events on the way down.
    const onScroll = (e: Event) => {
      const pre = e.target
      if (!(pre instanceof HTMLElement) || pre.tagName !== 'PRE') return
      const key = keyFor(pre)
      if (key) codeScrollRef.current.set(key, pre.scrollLeft)
    }
    container.addEventListener('scroll', onScroll, true)

    let queued = 0
    const restore = () => {
      queued = 0
      for (const pre of container.querySelectorAll('pre')) {
        const key = keyFor(pre)
        const want = key ? codeScrollRef.current.get(key) : undefined
        // Only ever push a block back out from the left edge. Restoring in any
        // other direction would fight a user who scrolled back to the start.
        if (want && pre.scrollLeft === 0) pre.scrollLeft = want
      }
    }
    const observer = new MutationObserver(() => {
      if (queued) return
      queued = requestAnimationFrame(restore)
    })
    observer.observe(container, { childList: true, subtree: true })

    return () => {
      container.removeEventListener('scroll', onScroll, true)
      observer.disconnect()
      if (queued) cancelAnimationFrame(queued)
    }
  }, [])

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    // React listens for 'scroll' at the root, so this also fires for nested
    // scrollers — e.g. dragging a code block sideways. Those ticks would
    // re-render the whole timeline (and, near the top, kick off scrollback),
    // which rebuilds the <pre> and throws away its horizontal position.
    if (e.target !== e.currentTarget) return
    const el = e.currentTarget
    // A hidden room measures 0 and reads as "at the bottom"; letting that
    // through would re-pin it and lose its place for when it is shown again.
    if (el.clientHeight === 0) return
    lastScrollTopRef.current = el.scrollTop
    // A held scrollbar thumb outranks this: autoscrolling the timeline here
    // would rebuild the <pre> and kill the drag. See scrollbarDragRef.
    if (scrollbarDragRef.current) return
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

  const onDictationText = useCallback((full: string) => {
    setInput(full)
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


  // follow: false is for the quick-command pills, which you tap from wherever
  // you are reading. The sent message lands at the end without taking you there.
  const sendMessage = useCallback(async (text: string, { follow = true }: { follow?: boolean } = {}) => {
    if (!text.trim() || sending) return
    hapticSend()
    // Keep the keyboard up only if the composer was already focused (i.e. the
    // user was typing and hit Enter/Send). Tapping a pill on a blurred input
    // should send silently without popping the keyboard.
    const keepFocus = document.activeElement === textareaRef.current
    stopDictation()
    // Only wipe the composer when what's being sent IS the composer's content.
    // Quick-action pills send their own text and must leave a half-typed
    // message alone.
    const clearedComposer = (textareaRef.current?.value ?? '') === text
    if (clearedComposer) {
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      setSuggestions([])
    }
    setSending(true)
    // The local echo and then the server's copy each become a new own-message
    // tail; the window has to outlast both.
    if (follow) requestAnimationFrame(scrollToBottom)
    else quietSendUntilRef.current = performance.now() + 10_000
    try {
      await client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: text,
        'com.construct.capabilities': ['actionable'],
        'com.construct.client': 'construct-web',
        'com.construct.version': __CONSTRUCT_VERSION__,
      } as any)
    } catch (err: any) {
      if (clearedComposer) setInput(text) // restore input so message isn't lost
      setSendError(err?.message ?? 'Failed to send')
      setTimeout(() => setSendError(''), 4000)
    } finally {
      setSending(false)
      if (keepFocus) textareaRef.current?.focus()
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

  const attachFile = useCallback((file: File) => {
    setPending((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl)
      return {
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      }
    })
    textareaRef.current?.focus()
  }, [])

  const clearPending = useCallback(() => {
    setPending((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
  }, [])

  // An attachment belongs to the room it was picked in.
  useEffect(() => clearPending, [roomId, clearPending])

  // One event for file and text: Matrix puts the caption in body and the
  // original name in filename, which is also how the bot tells them apart.
  const sendFile = useCallback(async (file: File, caption: string, previewUrl?: string) => {
    if (sending) return
    hapticSend()
    stopDictation()
    const text = caption.trim()
    setPending(null)
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setSuggestions([])
    setSending(true)
    requestAnimationFrame(scrollToBottom)
    try {
      const upload = await client.uploadContent(file, { name: file.name, type: file.type })
      const mxc = upload.content_uri
      const isImage = file.type.startsWith('image/')
      const msgContent: Record<string, unknown> = {
        msgtype: isImage ? 'm.image' : 'm.file',
        body: text || file.name,
        ...(text ? { filename: file.name } : {}),
        url: mxc,
        info: { mimetype: file.type, size: file.size },
        'com.construct.capabilities': ['actionable'],
        'com.construct.client': 'construct-web',
        'com.construct.version': __CONSTRUCT_VERSION__,
      }
      if (isImage) {
        await new Promise<void>((resolve) => {
          const img = new Image()
          img.onload = () => {
            msgContent.info = { ...msgContent.info as object, w: img.naturalWidth, h: img.naturalHeight }
            resolve()
          }
          img.onerror = () => resolve()
          img.src = previewUrl ?? URL.createObjectURL(file)
        })
      }
      await client.sendMessage(roomId, msgContent as any)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    } catch (err: any) {
      // Put both back so nothing typed or picked is lost.
      setPending({ file, previewUrl })
      setInput(caption)
      setSendError(err?.message ?? 'Failed to send file')
      setTimeout(() => setSendError(''), 4000)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }, [client, roomId, sending, scrollToBottom, stopDictation])

  // Sent straight away, like a photo from the camera prompt: the fix is the
  // whole message, and anything typed stays in the composer for after.
  const shareLocation = useCallback(async () => {
    if (sending) return
    setSending(true)
    setLocating(true)
    try {
      const loc = await currentLocation()
      setLocating(false)
      hapticSend()
      requestAnimationFrame(scrollToBottom)
      await client.sendMessage(roomId, {
        ...locationContent(loc),
        'com.construct.client': 'construct-web',
        'com.construct.version': __CONSTRUCT_VERSION__,
      } as any)
    } catch (err: any) {
      setSendError(err?.message ?? 'Failed to share location')
      setTimeout(() => setSendError(''), 4000)
    } finally {
      setLocating(false)
      setSending(false)
    }
  }, [client, roomId, sending, scrollToBottom])

  // What Send, Enter and dictation auto-send do: the composer's text, plus the
  // pending attachment if there is one.
  const sendComposer = useCallback((text: string) => {
    if (pending) void sendFile(pending.file, text, pending.previewUrl)
    else void sendMessage(text)
  }, [pending, sendFile, sendMessage])

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
    if (file) attachFile(file)
  }, [attachFile])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const fileItem = items.find(it => it.kind === 'file')
    if (!fileItem) return
    const file = fileItem.getAsFile()
    if (!file) return
    e.preventDefault()
    attachFile(file)
  }, [attachFile])

  useLayoutEffect(() => {
    autoSendToMessage.current = sendComposer
  }, [sendComposer])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendComposer(input)
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

  const copyMessage = useCallback((body: string) => {
    void copyTextToClipboard(body).then(() => showToast('Copied'))
  }, [showToast])

  // Long-press → action sheet, touch only. Delegated from the list rather than
  // wired per row, so MessageRow's memoised props stay as they are.
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  // Set when a press fired, so the click the lifting finger produces is eaten
  // instead of reaching whatever is under it (a code block copies on tap).
  const longPressFiredRef = useRef(false)
  const cancelLongPress = useCallback(() => {
    if (longPressRef.current) clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }, [])
  const handleMessagesPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    longPressFiredRef.current = false
    cancelLongPress()
    if (e.pointerType !== 'touch') return
    const target = e.target instanceof Element ? e.target : null
    if (!target?.closest('.message-pin-surface')) return
    // These keep the OS's own long-press: the link / image sheet, and selecting
    // inside a code block. Controls just get tapped.
    if (target.closest('a, img, video, pre, button, input, textarea, .msg-card')) return
    // Adjusting a live selection is not a new press.
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    const row = target.closest<HTMLElement>('[data-event-id]')
    // A row without the meta bar (decryption failure) has no actions to offer.
    if (!row?.querySelector('.message-meta')) return
    const eventId = row.dataset.eventId
    if (!eventId) return
    longPressRef.current = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        longPressRef.current = null
        longPressFiredRef.current = true
        // The sheet itself is unselectable; this drops anything the held
        // press had already started selecting before it opened.
        window.getSelection()?.removeAllRanges()
        hapticPress()
        setActionSheetId(eventId)
      }, 450),
    }
  }, [cancelLongPress])
  const handleMessagesPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = longPressRef.current
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancelLongPress()
  }, [cancelLongPress])
  const handleMessagesClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!longPressFiredRef.current) return
    longPressFiredRef.current = false
    e.preventDefault()
    e.stopPropagation()
  }, [])
  // Android turns a long-press into contextmenu; the sheet already answered it.
  const handleMessagesContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (longPressFiredRef.current || longPressRef.current) e.preventDefault()
  }, [])
  useEffect(() => cancelLongPress, [cancelLongPress])

  // Message text isn't selectable on touch (that is what frees long-press for
  // the sheet), so "Select text" switches one message back on and selects it
  // all, leaving the native handles to narrow it down. It switches off again
  // once the selection is dismissed.
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const selectMessageText = useCallback((eventId: string) => {
    setSelectingId(eventId)
    // After the class lands — selecting inside user-select:none is a no-op.
    requestAnimationFrame(() => {
      const surface = messagesRef.current?.querySelector(
        `[data-event-id="${window.CSS.escape(eventId)}"] .message-pin-surface`,
      )
      const text = surface?.querySelector('.bubble, .bot-text') ?? surface
      if (text) window.getSelection()?.selectAllChildren(text)
    })
  }, [])
  useEffect(() => {
    if (!selectingId) return
    const onChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setSelectingId(null)
    }
    // Registered a frame late so the selection made above isn't judged
    // before it exists.
    const raf = requestAnimationFrame(() => document.addEventListener('selectionchange', onChange))
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('selectionchange', onChange)
    }
  }, [selectingId])

  // MessageRow is memoised, so everything handed to it has to be referentially
  // stable — these wrappers exist so a row never re-renders just because an
  // inline arrow function was recreated.
  const toolGroupsRef = useRef<{ toolGroupId: Record<string, string>; messages: Message[] }>({
    toolGroupId: {},
    messages: [],
  })
  useEffect(() => {
    toolGroupsRef.current = { toolGroupId: toolGroups.toolGroupId, messages: visibleMessages }
  }, [toolGroups, visibleMessages])
  const openToolDialog = useCallback((eventId: string) => {
    const { toolGroupId, messages: msgs } = toolGroupsRef.current
    const groupId = toolGroupId[eventId]
    const lines = msgs
      .filter((m) => toolGroupId[m.eventId] === groupId)
      .flatMap((m) => parseToolProgressMessage(m.body, m))
    setToolDialog({ lines })
  }, [])
  const openLightbox = useCallback((url: string, alt: string) => setLightbox({ url, alt }), [])
  // togglePin is defined further down and changes identity; the ref keeps the
  // callback handed to rows constant.
  const togglePinRef = useRef<(id: string) => Promise<void>>(async () => {})
  const togglePinById = useCallback((eventId: string) => { void togglePinRef.current(eventId) }, [])

  const inspectMessage = useCallback((eventId: string) => {
    const room = client.getRoom(roomId)
    const ev = room?.findEventById(eventId)
    if (!ev) { showToast('Event not found'); return }
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
    void copyTextToClipboard(JSON.stringify(payload, null, 2))
      .then(() => showToast('Event JSON copied to clipboard'))
      .catch(() => showToast('Logged to console'))
  }, [client, roomId, showToast])

  const togglePin = useCallback(async (id: string) => {
    setPinInFlight(true)
    setPinError('')
    const isPinned = pinnedIdsRef.current.has(id)
    try {
      if (isPinned) await unpinRoomEvent(roomId, id)
      else await pinRoomEvent(roomId, id)
      refreshPinnedRef.current()
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : 'Could not update pins'
      setPinError(m)
      setTimeout(() => setPinError(''), 5000)
    } finally {
      setPinInFlight(false)
    }
  }, [roomId])
  useEffect(() => {
    togglePinRef.current = togglePin
  }, [togglePin])

  const sheetMsg = actionSheetId ? visibleMessages.find((m) => m.eventId === actionSheetId) : undefined

  const composing = input.trim() !== '' && !addingPill

  // The tool group the run is adding to right now — the one the timeline ends
  // in, when a run is on. Its chip carries the step in flight.
  const tailMessage = visibleMessages[visibleMessages.length - 1]
  const liveToolGroupId = agentRun && tailMessage && isBotToolProgress(tailMessage)
    ? toolGroups.toolGroupId[tailMessage.eventId] ?? null
    : null

  // The card's own full-change dialog when it has one; otherwise the card is
  // already complete in the timeline, so bring it into view.
  const viewApprovalCard = (msg: Message) => {
    if (msg.approval) { setApprovalDialog(msg.approval); return }
    messagesRef.current
      ?.querySelector(`[data-event-id="${window.CSS.escape(msg.eventId)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const footerError = sendError || dictationError || pinError
  const dismissFooterError = () => {
    setSendError('')
    setPinError('')
    clearDictationError()
  }

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
            {/* The activity row above the composer says this better when it's
                up; don't repeat it in the header. */}
            <span className={`chat-subtitle${typingUsers.length > 0 && !agentActivity ? ' chat-subtitle--thinking' : ''}`}>
              {typingUsers.length > 0 && !agentActivity
                ? `${bot?.name ?? 'Bot'} is thinking…`
                : (roomTopic || (bot?.name ?? null))}
            </span>
          </div>
          {/* Tapping the chip asks the room's bot for its model picker, which
              drops down from the chip. Agent rooms answer !model; Hermes rooms
              use !switch, since v0.21 rewrites !model there into upstream's
              reaction picker. */}
          {shownModel && (
            <div className="model-menu-anchor">
              <button
                type="button"
                className={`chat-header-model${showModelMenu ? ' chat-header-model--open' : ''}`}
                title={`Model: ${shownModel} — tap to switch`}
                aria-haspopup="menu"
                aria-expanded={showModelMenu}
                onClick={() => {
                  if (showModelMenu) { closeModelMenu(); return }
                  const agent = isAgentRoom(client, roomId)
                  const listed = agent ? agentRoomModels(client, roomId) : []
                  if (listed.length) { setModelMenuOptions(listed.map((id) => `!model ${id}`)); return }
                  // No list in state (Hermes, or a room the bot has not
                  // backfilled yet): ask the bot for its picker.
                  const command = agent ? '!model' : '!switch'
                  setModelMenuRequest(command)
                  void sendMessage(command, { follow: false })
                }}
              >
                {formatModel(shownModel)}
              </button>
              {showModelMenu && (
                <ModelMenu
                  current={shownModel}
                  options={modelMenuOptions ?? modelPicker?.options ?? []}
                  loading={!modelMenuOptions && modelMenuLoading}
                  onPick={(option) => {
                    closeModelMenu()
                    // The agent bot switches as soon as it reads the command,
                    // so the chip need not wait for its confirmation.
                    const picked = /^!model\s+(\S+)$/.exec(option)?.[1]
                    if (picked && modelMenuOptions) {
                      setCurrentModel(picked)
                      setRoomModel(roomId, picked)
                    }
                    void sendMessage(option, { follow: false })
                  }}
                  onClose={closeModelMenu}
                />
              )}
            </div>
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
        {isClaudeRoom && planUsage && (
          <HeaderUsageBar window={planUsage.session} fetchedAt={planUsage.fetchedAt} label="Claude session usage" />
        )}
        {isCodexRoom && codexUsage && (
          <HeaderUsageBar window={codexUsage.windows[0]} fetchedAt={codexUsage.fetchedAt} label="Codex usage" />
        )}
      </div>

      {showEditor &&<RoomEditor roomId={roomId} onClose={() => { setShowEditor(false); loadPills(client, roomId).then(setPills) }} onLeave={() => { setShowEditor(false); onBack() }} />}
      {approvalDialog && (
        <div className="room-editor-overlay" onClick={() => setApprovalDialog(null)}>
          <div className="room-editor" onClick={e => e.stopPropagation()}>
            <div className="room-editor-header">
              <span className="room-editor-title">{approvalDialog.title}</span>
              <button className="room-editor-close" onClick={() => setApprovalDialog(null)}>✕</button>
            </div>
            <div
              className="room-editor-body bot-text bot-text-rich approval-dialog-body"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(threadMd.parse(approvalDialog.body, { async: false }) as string) }}
            />
          </div>
        </div>
      )}
      {sheetMsg && (
        <MessageActionSheet
          msg={sheetMsg}
          subtitle={`${sheetMsg.isOwnMessage || !sheetMsg.authorName ? '' : `${sheetMsg.authorName} · `}${formatSentAt(sheetMsg.timestamp)}`}
          preview={sheetMsg.isOwnMessage ? sheetMsg.body : parseActions(sheetMsg.body).text}
          userId={userId}
          isPinned={pinnedEventIds.includes(sheetMsg.eventId)}
          pinInFlight={pinInFlight}
          onClose={closeActionSheet}
          onReact={sendReaction}
          onCopy={copyMessage}
          onSelectText={selectMessageText}
          onTogglePin={togglePinById}
          onInspect={inspectMessage}
        />
      )}

      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <button className="lightbox-close" aria-label="Close image" onClick={() => setLightbox(null)}>✕</button>
          <img className="lightbox-image" src={lightbox.url} alt={lightbox.alt} onClick={e => e.stopPropagation()} />
        </div>
      )}
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
                  onPointerDown={cleanHtml ? onBotRichTextPointerDown : undefined}
                >
                  {imgUrl ? (
                    <>
                      <img
                        className="pinned-image"
                        src={imgUrl}
                        alt=""
                        onClick={e => { e.stopPropagation(); setLightbox({ url: imgUrl, alt: msg.body || 'image' }) }}
                      />
                      {(plain || msg.body)?.trim() ? (
                        <div className="pinned-caption">{plain || msg.body}</div>
                      ) : null}
                    </>
                  ) : cleanHtml ? (
                    <div className="rich-html" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
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
          {loadError ? (
            <div className="messages-init-error">
              <p>Couldn't load messages</p>
              <button type="button" onClick={() => retryInitialLoadRef.current()}>Retry</button>
            </div>
          ) : (
            <span className="loading-dots"><span /><span /><span /></span>
          )}
        </div>
      )}
      <div
        className="messages"
        ref={messagesRef}
        onScroll={handleScroll}
        onPointerDown={handleMessagesPointerDown}
        onPointerMove={handleMessagesPointerMove}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onClickCapture={handleMessagesClickCapture}
        onContextMenu={handleMessagesContextMenu}
        style={initializing ? { visibility: 'hidden' } : undefined}
      >
        <div className="messages-inner">
          {loadingMore && (
            <div className="load-more">
              <span className="loading-dots"><span /><span /><span /></span>
            </div>
          )}

          {((() => {
            const { toolGroupId, collapsibleGroups } = toolGroups
            return <>{visibleMessages.map((msg, i) => {
            const showDateDivider = i === 0 || !sameDay(visibleMessages[i - 1].timestamp, msg.timestamp)
            const imageUrl = msg.imageUrl ?? (msg.imageMxc ? imageUrls[msg.eventId] : undefined)
            const fileUrl = msg.fileMxc ? imageUrls[msg.eventId] : undefined
            const isTool = isBotToolProgress(msg)
            const prev = i > 0 ? visibleMessages[i - 1] : null
            const next = i + 1 < visibleMessages.length ? visibleMessages[i + 1] : null
            const prevIsTool = !!(!showDateDivider && prev && isBotToolProgress(prev))
            const nextIsTool = !!(next && isBotToolProgress(next) &&
              sameDay(msg.timestamp, next.timestamp))
            const canPin = !msg.isDecryptionFailure
            // Only the row that starts a tool group renders a summary, so only
            // that row needs one computed.
            const groupId = toolGroupId[msg.eventId]
            const isGroupStart = isTool && !prevIsTool
            // The rest of the group is folded into that summary. Render no row
            // at all: an empty row still draws its meta bar (fixed height, and a
            // ⋯ on touch), so a bot that posts one event per tool call — the
            // agent rooms do — left a stack of blank messages under the chip.
            if (isTool && !isGroupStart) return null
            const toolSummary = isGroupStart
              ? summarizeToolLines(
                  visibleMessages
                    .filter(m => toolGroupId[m.eventId] === groupId)
                    .flatMap(m => parseToolProgressMessage(m.body, m)),
                )
              : ''
            const toolLive = isGroupStart && !collapsibleGroups.has(groupId)
            return (
              <MessageRow
                key={msg.eventId}
                msg={msg}
                userId={userId}
                showDateDivider={showDateDivider}
                senderSwitch={!!(prev && !showDateDivider && (prev.isOwnMessage !== msg.isOwnMessage || prev.senderName !== msg.senderName))}
                showPeerSender={!prev || showDateDivider || prev.senderName !== msg.senderName}
                isTool={isTool}
                prevIsTool={prevIsTool}
                nextIsTool={nextIsTool}
                canPin={canPin}
                toolSummary={toolSummary}
                toolLive={toolLive}
                imageUrl={imageUrl}
                fileUrl={fileUrl}
                isPinned={pinnedEventIds.includes(msg.eventId)}
                pinInFlight={pinInFlight}
                selecting={selectingId === msg.eventId}
                liveRun={groupId === liveToolGroupId ? agentRun : null}
                botTyping={groupId === liveToolGroupId && typingUsers.length > 0}
                onLiveChange={setAgentActivity}
                onOpenToolDialog={openToolDialog}
                onOpenLightbox={openLightbox}
                onOpenApproval={setApprovalDialog}
                onRichClick={onBotRichTextClick}
                onRichPointerDown={onBotRichTextPointerDown}
                onReact={sendReaction}
                onCopy={copyMessage}
                onTogglePin={togglePinById}
                onInspect={inspectMessage}
              />
            )
            })}</>
          })()) as React.ReactNode}
          {/* A run with no tool history to hang off yet (thinking, or talking
              between tools): its step still belongs at the end of the chat. */}
          {agentRun && !liveToolGroupId && (
            <div className="message other">
              <div className="message-body">
                <AgentActivityBar run={agentRun} botTyping={typingUsers.length > 0} onLiveChange={setAgentActivity} />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {cameraPrompt && (
        <div className="camera-prompt" onClick={() => { setCameraPrompt(false); cameraInputRef.current?.click() }}>
          <span className="material-icons camera-prompt-icon">photo_camera</span>
          <span className="camera-prompt-label">Tap to open camera</span>
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

        {agentBlocked && (
          <div className="agent-blocked" aria-live="polite">
            <span className="agent-blocked-text">
              {blockedHeadline(agentBlocked.reason)}
              {agentBlocked.canContinue
                // Past the reset the clock is history; what matters is that the
                // room is waiting on you, not on the provider.
                ? (agentBlocked.resetsAt ? ' · window reset' : '')
                : formatResetsAt(agentBlocked.resetsAt)
                  ? ` · resets ${formatResetsAt(agentBlocked.resetsAt)}`
                  : ''}
            </span>
            {/* Before the window rolls over the button is only a way to spend
                a turn on the same refusal, so it appears at the reset — which
                the hook flips on its own, without waiting for the bot. */}
            {agentBlocked.canContinue && (
              <button
                type="button"
                className="agent-blocked-btn"
                // Same reasoning as the pills: a tap must not steal focus from
                // (or hand it to) the composer.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendMessage('!continue')}
              >
                Continue working
              </button>
            )}
          </div>
        )}


        {pendingApproval && (
          <ApprovalBar
            key={pendingApproval.msg.eventId}
            card={pendingApproval.card}
            approve={pendingApproval.approve}
            deny={pendingApproval.deny}
            always={pendingApproval.always}
            session={pendingApproval.session}
            auto={pendingApproval.auto}
            onAnswer={(label) => { void sendMessage(label) }}
            onView={() => viewApprovalCard(pendingApproval.msg)}
          />
        )}
        {/* Hidden, not unmounted, while you type or while the approval bar
            stands in for it: the row would otherwise sit between you and the
            autocomplete, which offers the matching pills anyway. Kept in the
            DOM so a pill mid-drag or the add field keep their state. */}
        <div ref={pillsRowRef} className={`pills${composing || pendingApproval ?' pills--hidden' : ''}`} onWheel={(e) => { const el = e.currentTarget as HTMLDivElement; if (e.deltaY !== 0 && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY }}>
          {(modelPicker ? [] : lastActions).map((action) => (
            <button
              key={`action-${action}`}
              className="pill pill-action"
              // Don't let the tap move focus: a focused composer stays focused
              // (keyboard up), a blurred one stays blurred.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { resetPillsScroll(); sendMessage(action, { follow: false }) }}
            >
              {actionLabel(action)}
            </button>
          ))}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={pills} strategy={horizontalListSortingStrategy}>
              {pills.map((pill) => {
                const paramIdx = pill.indexOf('<>')
                const hasParam = paramIdx !== -1
                const onActivate = () => {
                  resetPillsScroll()
                  if (hasParam) {
                    textareaRef.current?.focus()
                    setInput(pill.slice(0, paramIdx))
                  } else {
                    sendMessage(pill, { follow: false })
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

        {/* One line for whichever failed last, not a stack of three: each would
            push the composer's contents around as it came and went. */}
        {footerError && (
          <div className="send-error" role="alert">
            <span className="send-error-text">{footerError}</span>
            <button
              type="button"
              className="send-error-dismiss"
              aria-label="Dismiss"
              onMouseDown={(e) => e.preventDefault()}
              onClick={dismissFooterError}
            >
              <span className="material-symbols-outlined" aria-hidden>close</span>
            </button>
          </div>
        )}

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

        {pending && (
          <div className="composer-attachment">
            {pending.previewUrl
              ? <img className="composer-attachment-thumb" src={pending.previewUrl} alt={pending.file.name} />
              : <span className="composer-attachment-thumb composer-attachment-file">
                  <span className="material-icons" aria-hidden>insert_drive_file</span>
                </span>}
            <span className="composer-attachment-name">{pending.file.name}</span>
            <button
              type="button"
              className="composer-attachment-remove"
              aria-label="Remove attachment"
              onMouseDown={(e) => e.preventDefault()}
              onClick={clearPending}
              disabled={sending}
            >
              <span className="material-symbols-outlined" aria-hidden>close</span>
            </button>
          </div>
        )}

        <div className="input-row-anchor">
        {/* Outside .input-row: a glass inside glass would blur only its parent. */}
        {attachMenuOpen && (
          <>
            <div className="model-menu-backdrop" onClick={() => setAttachMenuRoom(null)} />
            <div className="model-menu attach-menu glass" role="menu" aria-label="Attach">
              <button
                type="button"
                role="menuitem"
                className="model-menu-item attach-menu-item"
                style={{ '--i': 0 } as CSSProperties}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setAttachMenuRoom(null); fileInputRef.current?.click() }}
              >
                <span className="material-icons" aria-hidden>attach_file</span>
                Photo or file
              </button>
              <button
                type="button"
                role="menuitem"
                className="model-menu-item attach-menu-item"
                style={{ '--i': 1 } as CSSProperties}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setAttachMenuRoom(null); void shareLocation() }}
              >
                <span className="material-icons" aria-hidden>location_on</span>
                Location
              </button>
            </div>
          </>
        )}
        <div className="input-row glass">
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="file-input-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) attachFile(file)
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
              if (file) attachFile(file)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className="attach-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { hapticTick(); setAttachMenuRoom(attachMenuOpen ? null : roomId) }}
            disabled={sending}
            title={locating ? 'Finding your location' : 'Attach'}
            aria-label={locating ? 'Finding your location' : 'Attach'}
            aria-haspopup="menu"
            aria-expanded={attachMenuOpen}
          >
            {locating
              ? <span className="attach-btn-spinner" aria-hidden />
              : <span className="material-icons" aria-hidden>attach_file</span>}
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
                hapticTick()
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
                    ? 'Dictate — auto-send after you pause (toggle in Settings)'
                    : 'Dictate — send with Send button (enable auto-send in Settings)'
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
          {(input.trim() || pending || !showDictation) && (
            <button className="send-btn" onClick={() => sendComposer(input)} disabled={sending || (!input.trim() && !pending)}>
              {sending ? '…' : <><span className="send-btn-label">Send</span><span className="send-btn-icon">↑</span></>}
            </button>
          )}
        </div>
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


function eventToMessage(
  event: sdk.MatrixEvent,
  userId: string,
  maxReadTs: number,
  room?: sdk.Room,
  owners?: Set<string>,
): Message {
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

  // An agent's ```location blocks become map cards; the text around them stays.
  const rawHtml = !isFailure && content?.format === 'org.matrix.custom.html' && typeof content?.formatted_body === 'string'
    ? content.formatted_body as string
    : undefined
  const placed = isFailure ? undefined : extractLocationBlocks(String(body), rawHtml)
  if (placed?.locations.length) body = placed.body

  let formattedBody: string | undefined
  const html = placed?.locations.length ? placed.html : rawHtml
  if (html) formattedBody = sanitizeHtml(html)

  const sender = event.getSender() ?? ''
  const isOwnMessage = sender === userId
  const isRead = isOwnMessage && event.getTs() <= maxReadTs

  const roomOwners = owners ?? getRoomOwners(room)
  const isPeerMessage = !isOwnMessage && roomOwners.size > 0 && !roomOwners.has(sender)
  const senderName = isPeerMessage
    ? (room?.getMember(sender)?.rawDisplayName || shortUserId(sender))
    : undefined
  // Unlike senderName this is set for every message, peer or not: the meta row
  // names the author for anything that isn't the user's own message.
  const authorName = room?.getMember(sender)?.rawDisplayName || shortUserId(sender)

  const imageMxc = content?.msgtype === 'm.image' && content?.url ? content.url : undefined
  const fileMxc = content?.msgtype === 'm.file' && content?.url ? content.url : undefined
  // With a caption, body is the caption and filename the original name;
  // without one, body is the name.
  const mediaFilename = typeof content?.filename === 'string' ? content.filename : undefined
  const caption = (imageMxc || fileMxc) && mediaFilename && body && body !== mediaFilename ? body : undefined
  const fileName = fileMxc ? (mediaFilename ?? content?.body ?? 'file') : undefined
  const fileMime = fileMxc ? (content?.info?.mimetype ?? 'application/octet-stream') : undefined
  const location = isFailure ? undefined : locationFromContent(content)

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

  const rawMachine = content?.['com.construct.machine']
  const machine = rawMachine && typeof rawMachine === 'object'
    ? {
        kind: typeof (rawMachine as any).kind === 'string' ? String((rawMachine as any).kind) : undefined,
        source: typeof (rawMachine as any).source === 'string' ? String((rawMachine as any).source) : undefined,
      }
    : rawMachine === true ? {} : undefined

  const rawApproval = content?.['com.construct.approval']
  const approval = rawApproval && typeof rawApproval === 'object'
    && typeof rawApproval.body === 'string' && typeof rawApproval.title === 'string'
    ? {
        title: String(rawApproval.title),
        lines: Number(rawApproval.lines) || String(rawApproval.body).split('\n').length,
        body: String(rawApproval.body),
      }
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
    caption,
    location,
    places: placed?.locations.length ? placed.locations : undefined,
    cards: cards && cards.length > 0 ? cards : undefined,
    threads: threads && threads.length > 0 ? threads : undefined,
    approval,
    toolProgress: toolProgress && toolProgress.length > 0 ? toolProgress : undefined,
    timestamp: event.getTs(),
    isOwnMessage,
    isPeerMessage,
    senderName,
    authorName,
    isDecryptionFailure: isFailure,
    isRead,
    source,
    machine,
    interim: content?.['com.construct.interim'] === true ? true : undefined,
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
  const owners = getRoomOwners(room)
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
      let msg = eventToMessage(edit ?? e, userId, maxReadTs, room, owners)
      if (edit) msg = { ...msg, eventId: id, timestamp: e.getTs() }
      const reactions = reactionsMap[msg.eventId]
      return reactions ? { ...msg, reactions } : msg
    })
}

// `hr` earns its place: a `---` is how a reply marks a section break, and
// stripping the tag silently collapsed two sections into one wall of text.
const ALLOWED_TAGS = /^(p|br|hr|strong|b|em|i|u|s|del|code|pre|ul|ol|li|blockquote|h[1-6]|a|span|table|thead|tbody|tr|th|td)$/i
const ALLOWED_ATTRS: Record<string, string[]> = { a: ['href', 'target', 'rel'], span: ['class'], code: ['class'] }
// Class names are an allowlist, not free text: the bot marks up diff lines with
// these and nothing else may borrow the app's styling.
const ALLOWED_CLASSES = /^(diff|diff-add|diff-del|diff-meta|diff-ctx|diff-mark|cmd)$/

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
      const cls = el.getAttribute('class')
      if (cls !== null && !ALLOWED_CLASSES.test(cls)) el.removeAttribute('class')
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

// "Today at 14:23" / "3 August at 14:23" — reuses formatDate so the day label
// reads the same as the timeline's date dividers.
function formatSentAt(ts: number): string {
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${formatDate(ts)} at ${time}`
}

function shortUserId(userId: string): string {
  return userId.replace(/^@/, '').split(':')[0] ?? userId
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

// Fixed so the tiles can be laid out without measuring; CSS caps the width.
const MAP_W = 264
const MAP_H = 140
const MAP_ZOOM = 16

// A shared location: a map tile preview with a pin, and the coordinates under
// it. Tap opens it in Google Maps.
function LocationLink({ location }: { location: NonNullable<Message['location']> }) {
  const tiles = useMemo(() => mapTiles(location, MAP_ZOOM, MAP_W, MAP_H), [location])
  return (
    <a
      href={mapsUrl(location)}
      className="msg-location"
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="msg-location-map" style={{ width: MAP_W, height: MAP_H }} aria-hidden>
        {tiles.map((t) => (
          <img key={t.url} src={t.url} alt="" draggable={false} loading="lazy" style={{ left: t.x, top: t.y }} />
        ))}
        <span className="material-icons msg-location-pin">location_on</span>
        <span className="msg-location-attribution">{MAP_ATTRIBUTION}</span>
      </span>
      <span className="msg-location-text">
        <span className="msg-location-title">{location.description ?? 'Location'}</span>
        <span className="msg-location-coords">
          {formatCoords(location)}{location.accuracy != null && ` · ±${location.accuracy} m`}
        </span>
      </span>
    </a>
  )
}

export interface MessageRowProps {
  msg: Message
  userId: string
  /** Row shape, all precomputed by the parent from neighbouring messages. */
  showDateDivider: boolean
  senderSwitch: boolean
  showPeerSender: boolean
  isTool: boolean
  prevIsTool: boolean
  nextIsTool: boolean
  canPin: boolean
  /** Tool-group summary, for the one row that starts a group. */
  toolSummary: string
  toolLive: boolean
  imageUrl?: string
  fileUrl?: string
  isPinned: boolean
  pinInFlight: boolean
  /** "Select text" from the action sheet re-enabled selection on this row. */
  selecting: boolean
  /** Only on the row that starts the tool group the run is adding to: the run,
   *  so the chip can show the step in flight under its summary. */
  liveRun: AgentRun | null
  botTyping: boolean
  onLiveChange: (live: boolean) => void
  onOpenToolDialog: (eventId: string) => void
  onOpenLightbox: (url: string, alt: string) => void
  onOpenApproval: (approval: ConstructApproval) => void
  onRichClick: (e: React.MouseEvent<HTMLDivElement>) => void
  onRichPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onReact: (eventId: string, emoji: string) => void
  onCopy: (body: string) => void
  onTogglePin: (eventId: string) => void
  onInspect: (eventId: string) => void
}

/**
 * One row of the timeline.
 *
 * Memoised on purpose: the bot sends a tool-progress line every few seconds
 * during a run, and without this every arrival re-rendered every row in the
 * room — which rebuilds their code blocks and kills a scrollbar drag in
 * progress. Props are therefore primitives and stable callbacks only; anything
 * derived from neighbouring messages is computed by the parent so this compares
 * cheaply.
 */
function MessageRowInner({
  msg,
  userId,
  showDateDivider,
  senderSwitch,
  showPeerSender,
  isTool,
  prevIsTool,
  nextIsTool,
  canPin,
  toolSummary,
  toolLive,
  imageUrl,
  fileUrl,
  isPinned,
  pinInFlight,
  selecting,
  liveRun,
  botTyping,
  onLiveChange,
  onOpenToolDialog,
  onOpenLightbox,
  onOpenApproval,
  onRichClick,
  onRichPointerDown,
  onReact,
  onCopy,
  onTogglePin,
  onInspect,
}: MessageRowProps) {
  return (
              <div
                data-event-id={msg.eventId}
                className={isTool ? `tool-progress-wrap${prevIsTool ? ' tool-progress-wrap-cont' : ''}${nextIsTool ? ' tool-progress-wrap-open' : ''}` : undefined}
              >
                {showDateDivider && (
                  <div className="date-divider">
                    <span>{formatDate(msg.timestamp)}</span>
                  </div>
                )}
                <div className={`message ${msg.isOwnMessage ? 'own' : 'other'}${msg.isPeerMessage ? ' peer' : ''}${senderSwitch ? ' sender-switch' : ''}${selecting ? ' message--selecting' : ''}`}>
                  <div className="message-body">
                    {/* Another member's request, not the bot's own voice — say whose. */}
                    {msg.isPeerMessage && showPeerSender && (
                      <div className="peer-sender">{msg.senderName}</div>
                    )}
                    {msg.isOwnMessage ? (
                      <>
                        <div className="message-pin-surface message-pin-surface--own">
                          <div className={`bubble ${msg.isDecryptionFailure ? 'bubble-failed' : ''} ${imageUrl ? (msg.caption ? 'bubble-image-captioned' : 'bubble-image') : ''} ${msg.source === 'voice' ? 'bubble-voice' : ''}`}>
                            {msg.source === 'voice' && (
                              <span className="material-icons bubble-voice-icon" title="Voice input">mic</span>
                            )}
                            {imageUrl
                              ? <img src={imageUrl} alt={msg.body || 'image'} className="msg-image" onClick={e => { e.stopPropagation(); onOpenLightbox(imageUrl, msg.body || 'image') }} />
                              : msg.location
                              ? <LocationLink location={msg.location} />
                              : fileUrl
                                ? <a href={fileUrl} download={msg.fileName} className="msg-file" target="_blank" rel="noreferrer"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</a>
                                : msg.fileMxc && !fileUrl
                                  ? <span className="msg-file msg-file-loading"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</span>
                                  : msg.body}
                            {/* Until the image loads, the body fallback above is already the caption. */}
                            {msg.caption && (imageUrl || msg.fileMxc) && <div className="msg-caption">{msg.caption}</div>}
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
                            const isGroupStart = !prevIsTool

                            // Non-start messages in any group are hidden — summary shown at group start
                            if (!isGroupStart) return null

                            // All groups show as a summary chip (live group updates in real time)
                            const chip = (
                              <div
                                className={`tool-progress tool-progress-collapsed${toolLive ? ' tool-progress-live' : ''}`}
                                onClick={() => onOpenToolDialog(msg.eventId)}
                              >
                                <span className="tool-progress-tool">{toolSummary}</span>
                                {toolLive && <span className="tool-progress-live-dot" />}
                              </div>
                            )
                            // While the run is on, the group is just what it's
                            // doing now ("Searching AppDelegate.swift"), changing
                            // as it moves on; the summary of what it did takes
                            // over once it's done — or if the run goes quiet.
                            if (!liveRun) return chip
                            return (
                              <div className="tool-progress-now" onClick={() => onOpenToolDialog(msg.eventId)}>
                                <AgentActivityBar run={liveRun} botTyping={botTyping} onLiveChange={onLiveChange} fallback={chip} />
                              </div>
                            )

                            // dead code kept for type-checker
                            const lines = parseToolProgressMessage(msg.body, msg)
                            return (
                              <div
                                className={`message-pin-surface message-pin-surface--tool tool-progress${prevIsTool ? ' tool-progress-cont' : ''}${nextIsTool ? ' tool-progress-open' : ''}`}
                               
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
                              <div className="message-pin-surface">
                                <div
                                  className={`bot-text ${cleanHtml ? 'bot-text-rich' : ''} ${msg.isDecryptionFailure ? 'bubble-failed' : ''} ${msg.machine ? 'bot-text-machine' : ''}`}
                                  onClick={cleanHtml ? onRichClick : undefined}
                                  onPointerDown={cleanHtml ? onRichPointerDown : undefined}
                                  title={msg.machine?.source ? `Machine message from ${msg.machine.source}` : undefined}
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
                                    ? <img src={imageUrl} alt={msg.body || 'image'} className="msg-image" onClick={e => { e.stopPropagation(); onOpenLightbox(imageUrl, msg.body || 'image') }} />
                                    : msg.location
                                    ? <LocationLink location={msg.location} />
                                    : fileUrl
                                      ? <a href={fileUrl} download={msg.fileName} className="msg-file" target="_blank" rel="noreferrer"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</a>
                                      : msg.fileMxc && !fileUrl
                                        ? <span className="msg-file msg-file-loading"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</span>
                                        : cleanHtml
                                          ? <div className="rich-html" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
                                          : text}
                                  {msg.caption && !msg.cards && !msg.threads && (imageUrl || msg.fileMxc) && <div className="msg-caption">{msg.caption}</div>}
                                  {msg.places && (
                                    <div className="msg-places">
                                      {msg.places.map((place, pi) => <LocationLink key={pi} location={place} />)}
                                    </div>
                                  )}
                                </div>
                                {msg.approval && (
                                  <button
                                    className="approval-full-btn"
                                    onClick={(e) => { e.stopPropagation(); onOpenApproval(msg.approval!) }}
                                  >
                                    <span className="material-icons approval-full-icon">unfold_more</span>
                                    View all {msg.approval.lines} lines
                                  </button>
                                )}
                              </div>
                              {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                                <div className="reaction-bar">
                                  {Object.entries(msg.reactions).map(([emoji, senders]) => (
                                    <button
                                      key={emoji}
                                      className={`reaction-btn${senders.includes(userId) ? ' reaction-btn--active' : ''}`}
                                      onClick={() => onReact(msg.eventId, emoji)}
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
                    {canPin && (
                      // Always rendered, only hidden: reserving the row's height
                      // keeps messages from jumping on hover, and the reserved
                      // space doubles as the gap between messages.
                      // On touch it never shows: a long-press opens the same
                      // actions in a sheet (see handleMessagesPointerDown).
                      <div className="message-meta">
                        <span className="message-meta-actions">
                          <button
                            type="button"
                            className="message-meta-btn"
                            aria-label="Copy message"
                            onClick={() => onCopy(msg.body)}
                          >
                            <span className="material-symbols-outlined">content_copy</span>
                          </button>
                          <button
                            type="button"
                            className={`message-meta-btn${isPinned ? ' message-meta-btn--on' : ''}`}
                            aria-label={isPinned ? 'Unpin message' : 'Pin message'}
                            disabled={pinInFlight}
                            onClick={() => { onTogglePin(msg.eventId) }}
                          >
                            <span className="material-symbols-outlined">keep</span>
                          </button>
                          <button
                            type="button"
                            className="message-meta-btn"
                            aria-label="Inspect event"
                            onClick={() => onInspect(msg.eventId)}
                          >
                            <span className="material-symbols-outlined">data_object</span>
                          </button>
                        </span>
                        <span className="message-meta-info">
                          {/* Own messages: the bubble's side already says who
                              sent it, so only the time is worth showing. */}
                          {msg.isOwnMessage ? '' : <>{msg.authorName}{msg.authorName ? ' · ' : ''}</>}{formatSentAt(msg.timestamp)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
  )
}

export const MessageRow = memo(MessageRowInner)
