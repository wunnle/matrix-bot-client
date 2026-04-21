import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
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
import { getClient } from '../lib/matrix'
import { loadPills, savePills } from '../lib/roomMeta'
import { resolveMediaUrl } from '../lib/mediaUrl'
import RoomEditor from './RoomEditor'
import type { Message, RoomConfig } from '../types'

interface Props {
  roomId: string
  roomName: string
  config?: RoomConfig
  userId: string
  onBack: () => void
}

const PAGE_SIZE = 30
const RENDER_LIMIT = 60
const SLIDE_SIZE = 30


// Matches lines like: "📖 read_file: "/path..."" or "🔧 patch: "..." (×2)"
const TOOL_PROGRESS_LINE = /^(?:\*\s*)?\S\S?\s+\w[\w./-]*(?::\s+".{0,80}"(?:\s+\(×\d+\))?|\.\.\.)\s*$/u

function isToolProgressMessage(body: string): boolean {
  const lines = body.split('\n').filter(l => l.trim() !== '')
  return lines.length > 0 && lines.every(l => TOOL_PROGRESS_LINE.test(l.trim()))
}

function parseActions(body: string): { text: string; actions: string[] } {
  const actions: string[] = []
  const text = body.replace(/\[\[([^\]]{1,40})\]\]/g, (_, label) => {
    actions.push(label.trim())
    return ''
  }).trim()
  return { text, actions }
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

export default function ChatView({ roomId, roomName, config, userId, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showEditor, setShowEditor] = useState(false)
  const [pills, setPills] = useState<string[]>([])
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
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [renderStart, setRenderStart] = useState(0)
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const [bot, setBot] = useState<{ name: string; avatarUrl: string | null } | null>(null)
  const [sendError, setSendError] = useState('')
  const [showScrollDown, setShowScrollDown] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLInputElement>(null)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const client = getClient()

  const visibleMessages = useMemo(
    () => messages.slice(renderStart, renderStart + RENDER_LIMIT),
    [messages, renderStart],
  )

  useEffect(() => {
    isFirstLoad.current = true
    stickToBottomRef.current = true
    lastTailEventIdRef.current = undefined
    setHasMore(true)
    setMessages([])
    setRenderStart(0)
    resolvedImagesRef.current = new Set()
    setImageUrls({})

    const room = client.getRoom(roomId)
    if (!room) return

    // Render once after we have enough events to fill the viewport, to
    // avoid a double render/jump: cached-short-content → scrollback-tall-content.
    const existing = room.getLiveTimeline().getEvents()
    if (existing.length >= 20) {
      setMessages(eventsToMessages(existing, userId, room))
    } else {
      client.scrollback(room, 20)
        .then(() => {
          setMessages(eventsToMessages(room.getLiveTimeline().getEvents(), userId, room))
        })
        .catch(() => {
          setMessages(eventsToMessages(room.getLiveTimeline().getEvents(), userId, room))
        })
    }

    const onEvent = (event: sdk.MatrixEvent, room_: sdk.Room | undefined) => {
      if (room_?.roomId !== roomId) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return
      const maxReadTs = getMaxReadTs(room_, userId)
      setMessages((prev) => {
        const id = event.getId() ?? ''
        if (prev.some((m) => m.eventId === id)) return prev
        return [...prev, eventToMessage(event, userId, maxReadTs)]
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
      setMessages((prev) =>
        prev.map((m) =>
          m.eventId === (event.getId() ?? '') ? eventToMessage(event, userId, maxReadTs) : m
        )
      )
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

    client.on(sdk.MatrixEventEvent.Decrypted, onDecrypted)
    client.on(sdk.RoomEvent.Timeline, onEvent)
    client.on(sdk.RoomEvent.Receipt, onReceipt)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onEvent)
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

  // Resolve mxc image URLs to authenticated blob URLs. Kept out of
  // `messages` so resolution doesn't mutate the message array and
  // re-trigger this effect in a feedback loop.
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({})
  const resolvedImagesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const toResolve: { eventId: string; mxc: string }[] = []
    for (const m of messages) {
      if (m.imageMxc && !m.imageUrl && !resolvedImagesRef.current.has(m.eventId)) {
        resolvedImagesRef.current.add(m.eventId)
        toResolve.push({ eventId: m.eventId, mxc: m.imageMxc })
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
  }, [messages, client])

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

  // Advance renderStart to keep render window pinned to bottom when new messages arrive
  useEffect(() => {
    if (messages.length <= RENDER_LIMIT) { setRenderStart(0); return }
    setRenderStart(prev => {
      const isPinnedToBottom = prev + RENDER_LIMIT >= messages.length
      if (isPinnedToBottom) return Math.max(0, messages.length - RENDER_LIMIT)
      return prev
    })
  }, [messages.length])

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
  // useLayoutEffect so we set scrollTop before the browser paints the new
  // content. Otherwise there's a one-frame flash where the new messages
  // render at the top of the scroll container before being scrolled down.
  useLayoutEffect(() => {
    if (visibleMessages.length === 0) return
    const tail = visibleMessages[visibleMessages.length - 1]
    const tailChanged = tail.eventId !== lastTailEventIdRef.current
    lastTailEventIdRef.current = tail.eventId
    const shouldScroll = stickToBottomRef.current || (tailChanged && tail.isOwnMessage)
    if (!shouldScroll) return
    const behavior: ScrollBehavior = (!isFirstLoad.current && tailChanged && tail.isOwnMessage) ? 'smooth' : 'instant'
    isFirstLoad.current = false
    programmaticScrollUntilRef.current = performance.now() + (behavior === 'smooth' ? 500 : 100)
    bottomRef.current?.scrollIntoView({ behavior })
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Load older messages
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    const room = client.getRoom(roomId)
    if (!room) return

    const container = messagesRef.current
    const prevScrollHeight = container?.scrollHeight ?? 0

    setLoadingMore(true)
    try {
      const result = await client.scrollback(room, PAGE_SIZE)
      const allEvents = result.getLiveTimeline().getEvents()
      const msgs = eventsToMessages(allEvents, userId, result)
      setMessages(msgs)

      // If we got fewer than PAGE_SIZE new messages, we've reached the start
      if (result.oldState.paginationToken === null) {
        setHasMore(false)
      }

      // Restore scroll position after prepend
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevScrollHeight
        }
      })
    } catch {
      setHasMore(false)
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
    if (scrollTop < 80) {
      if (renderStart > 0) {
        const container = e.currentTarget
        const prevScrollHeight = container.scrollHeight
        setRenderStart(prev => Math.max(0, prev - SLIDE_SIZE))
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight - prevScrollHeight
        })
      } else if (!loadingMore && hasMore) {
        loadMore()
      }
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

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || sending) return
    setInput('')
    setSuggestions([])
    setSending(true)
    try {
      await client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: text,
        'com.construct.capabilities': ['actionable'],
      } as any)
    } catch (err: any) {
      setInput(text) // restore input so message isn't lost
      setSendError(err?.message ?? 'Failed to send')
      setTimeout(() => setSendError(''), 4000)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }, [client, roomId, sending, scrollToBottom])

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

  return (
    <div className="chat-view" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div className="chat-header">
        <div className="chat-header-inner">
          <button className="back" onClick={onBack}>←</button>
          {bot?.avatarUrl
            ? <img className="chat-avatar" src={bot.avatarUrl} alt="" />
            : <div className="chat-avatar chat-avatar-fallback">{(bot?.name ?? roomName).slice(0, 1).toUpperCase()}</div>}
          <div className="chat-header-info">
            <span className="chat-title">{bot?.name ?? roomName}</span>
            <span className={`chat-subtitle${typingUsers.length > 0 ? ' chat-subtitle--thinking' : ''}`}>
              {typingUsers.length > 0 ? 'thinking…' : (bot ? roomName : null)}
            </span>
          </div>
          <button className="header-action" onClick={() => setShowEditor(true)} title="Room settings">⚙︎</button>
        </div>
      </div>

      {showEditor && <RoomEditor roomId={roomId} onClose={() => { setShowEditor(false); loadPills(client, roomId).then(setPills) }} onLeave={() => { setShowEditor(false); onBack() }} />}

      <div className="messages" ref={messagesRef} onScroll={handleScroll}>
        <div className="messages-inner">
          {hasMore && (
            <div className="load-more">
              {loadingMore
                ? <span className="loading-dots"><span /><span /><span /></span>
                : <button onClick={loadMore}>Load older messages</button>
              }
            </div>
          )}

          {visibleMessages.map((msg, i) => {
            const showDateDivider = i === 0 || !sameDay(visibleMessages[i - 1].timestamp, msg.timestamp)
            const imageUrl = msg.imageUrl ?? imageUrls[msg.eventId]
            return (
              <div key={msg.eventId}>
                {showDateDivider && (
                  <div className="date-divider">
                    <span>{formatDate(msg.timestamp)}</span>
                  </div>
                )}
                <div className={`message ${msg.isOwnMessage ? 'own' : 'other'}`}>
                  <div className="message-body">
                    {msg.isOwnMessage ? (
                      <>
                        <div className={`bubble ${msg.isDecryptionFailure ? 'bubble-failed' : ''} ${imageUrl ? 'bubble-image' : ''}`}>
                          {imageUrl ? <img src={imageUrl} alt={msg.body || 'image'} className="msg-image" /> : msg.body}
                        </div>
                        <div className={`msg-status ${msg.isRead ? 'msg-status-read' : ''}`}>
                          <span className="material-icons">{msg.isRead ? 'done_all' : 'done'}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        {(() => {
                          if (isToolProgressMessage(msg.body)) {
                            return (
                              <div className="tool-progress">
                                {msg.body.split('\n').filter(l => l.trim()).map((line, i) => (
                                  <div key={i} className="tool-progress-line">{line}</div>
                                ))}
                              </div>
                            )
                          }
                          const { text } = parseActions(msg.body)
                          const cleanHtml = msg.formattedBody
                            ? msg.formattedBody.replace(/\[\[([^\]]{1,40})\]\]/g, '').trim()
                            : undefined
                          return (
                            <>
                              <div className={`bot-text ${cleanHtml ? 'bot-text-rich' : ''} ${msg.isDecryptionFailure ? 'bubble-failed' : ''}`}>
                                {imageUrl
                                  ? <img src={imageUrl} alt={msg.body || 'image'} className="msg-image" />
                                  : cleanHtml
                                    ? <span dangerouslySetInnerHTML={{ __html: cleanHtml }} />
                                    : text}
                              </div>
                            </>
                          )
                        })()}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {renderStart + RENDER_LIMIT < messages.length && (
            <div className="load-more">
              <button onClick={() => {
                setRenderStart(Math.max(0, messages.length - RENDER_LIMIT))
                requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'instant' }))
              }}>Jump to latest</button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {showScrollDown && (
        <button className="scroll-down-btn" onClick={scrollToBottom} aria-label="Scroll to bottom">↓</button>
      )}

      <div className="chat-footer">

        <div className="pills">
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

        <div className="input-row">
          <input
            ref={textareaRef as React.RefObject<HTMLInputElement>}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 300)}
            placeholder="Message…"
            disabled={sending}
            enterKeyHint="send"
          />
          <button className="send-btn" onClick={() => sendMessage(input)} disabled={sending || !input.trim()}>
            {sending ? '…' : <><span className="send-btn-label">Send</span><span className="send-btn-icon">↑</span></>}
          </button>
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
  const content = event.getContent()
  let body = content?.body ?? ''
  let imageUrl: string | undefined

  if (isFailure || (isEncrypted && !body)) {
    body = '🔒 Unable to decrypt'
  } else if (content?.msgtype === 'm.image' && content?.url) {
    body = content.body ?? ''
  }

  let formattedBody: string | undefined
  if (!isFailure && content?.format === 'org.matrix.custom.html' && content?.formatted_body) {
    formattedBody = sanitizeHtml(content.formatted_body)
  }

  const isOwnMessage = event.getSender() === userId
  const isRead = isOwnMessage && event.getTs() <= maxReadTs

  const imageMxc = content?.msgtype === 'm.image' && content?.url ? content.url : undefined

  return {
    eventId: event.getId() ?? event.getTs().toString(),
    sender: event.getSender() ?? '',
    body,
    formattedBody,
    imageUrl,
    imageMxc,
    timestamp: event.getTs(),
    isOwnMessage,
    isDecryptionFailure: isFailure,
    isRead,
  }
}

function eventsToMessages(events: sdk.MatrixEvent[], userId: string, room: sdk.Room): Message[] {
  const maxReadTs = getMaxReadTs(room, userId)
  return events
    .filter((e) => e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted' || e.isDecryptionFailure())
    .map((e) => eventToMessage(e, userId, maxReadTs))
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

