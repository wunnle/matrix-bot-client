import { useEffect, useRef, useState, useCallback } from 'react'
import * as sdk from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'
import type { Message, RoomConfig } from '../types'

interface Props {
  roomId: string
  roomName: string
  config?: RoomConfig
  userId: string
  onBack: () => void
}

const PAGE_SIZE = 30

export default function ChatView({ roomId, roomName, config, userId, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const [sendError, setSendError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLInputElement>(null)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const client = getClient()

  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return

    // Pre-load recent history then set messages
    client.scrollback(room, PAGE_SIZE).catch(() => {}).finally(() => {
      setMessages(eventsToMessages(room.getLiveTimeline().getEvents(), userId))
    })

    const onEvent = (event: sdk.MatrixEvent, room_: sdk.Room | undefined) => {
      if (room_?.roomId !== roomId) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return
      setMessages((prev) => {
        const id = event.getId() ?? ''
        if (prev.some((m) => m.eventId === id)) return prev
        return [...prev, eventToMessage(event, userId)]
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
      setMessages((prev) =>
        prev.map((m) =>
          m.eventId === (event.getId() ?? '') ? eventToMessage(event, userId) : m
        )
      )
    }

    client.on(sdk.MatrixEventEvent.Decrypted, onDecrypted)
    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onEvent)
      client.off(sdk.MatrixEventEvent.Decrypted, onDecrypted)
    }
  }, [roomId, userId, client])

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

  // Scroll to bottom only on initial load and own messages
  const isFirstLoad = useRef(true)
  useEffect(() => {
    if (isFirstLoad.current && messages.length > 0) {
      bottomRef.current?.scrollIntoView()
      isFirstLoad.current = false
    }
  }, [messages])

  // Reset on room change
  useEffect(() => {
    isFirstLoad.current = true
    setHasMore(true)
    setMessages([])
  }, [roomId])

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
      const msgs = eventsToMessages(allEvents, userId)
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

  // Trigger load more when scrolled to top
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop < 80 && !loadingMore && hasMore) {
      loadMore()
    }
  }

  // Autocomplete
  useEffect(() => {
    const all = [...(config?.pills ?? []), ...(config?.suggestions ?? [])]
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
      await client.sendTextMessage(roomId, text)
      scrollToBottom()
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
        <button className="back" onClick={onBack}>←</button>
        <span className="chat-title">{roomName}</span>
      </div>

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

          {messages.map((msg, i) => {
            const showDateDivider = i === 0 || !sameDay(messages[i - 1].timestamp, msg.timestamp)
            return (
              <div key={msg.eventId}>
                {showDateDivider && (
                  <div className="date-divider">
                    <span>{formatDate(msg.timestamp)}</span>
                  </div>
                )}
                <div className={`message ${msg.isOwnMessage ? 'own' : 'other'}`}>
                  <div className="message-body">
                    {!msg.isOwnMessage && (
                      <div className="sender">{shortName(msg.sender)}</div>
                    )}
                    <div className={`bubble ${msg.isDecryptionFailure ? 'bubble-failed' : ''}`}>{msg.body}</div>
                    <div className="timestamp">{formatTime(msg.timestamp)}</div>
                  </div>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="chat-footer">
        {typingUsers.length > 0 && (
          <div className="typing-indicator">
            <span className="typing-dots"><span /><span /><span /></span>
            <span className="typing-label">
              {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing
            </span>
          </div>
        )}

        {config?.pills && config.pills.length > 0 && (
          <div className="pills">
            {config.pills.map((pill) => (
              <button key={pill} className="pill" onClick={() => sendMessage(pill)}>
                {pill}
              </button>
            ))}
          </div>
        )}

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
          <button onClick={() => sendMessage(input)} disabled={sending || !input.trim()}>
            {sending ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

function eventToMessage(event: sdk.MatrixEvent, userId: string): Message {
  const isFailure = event.isDecryptionFailure()
  const isEncrypted = event.getType() === 'm.room.encrypted'
  let body = event.getContent()?.body ?? ''

  if (isFailure || (isEncrypted && !body)) {
    body = '🔒 Unable to decrypt'
  }

  return {
    eventId: event.getId() ?? event.getTs().toString(),
    sender: event.getSender() ?? '',
    body,
    timestamp: event.getTs(),
    isOwnMessage: event.getSender() === userId,
    isDecryptionFailure: isFailure,
  }
}

function eventsToMessages(events: sdk.MatrixEvent[], userId: string): Message[] {
  return events
    .filter((e) => e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted' || e.isDecryptionFailure())
    .map((e) => eventToMessage(e, userId))
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

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
