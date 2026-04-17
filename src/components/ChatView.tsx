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
  const [syncing, setSyncing] = useState(true)
  const [sending, setSending] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const client = getClient()

  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return

    setMessages(eventsToMessages(room.getLiveTimeline().getEvents(), userId))
    setSyncing(false)

    const onEvent = (event: sdk.MatrixEvent, room_: sdk.Room | undefined) => {
      if (room_?.roomId !== roomId) return
      if (event.getType() !== 'm.room.message') return
      setMessages((prev) => {
        const id = event.getId() ?? ''
        if (prev.some((m) => m.eventId === id)) return prev
        return [...prev, eventToMessage(event, userId)]
      })
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => { client.off(sdk.RoomEvent.Timeline, onEvent) }
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
    setSyncing(true)
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

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  }, [input])

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

  return (
    <div className="chat-view">
      <div className="chat-header">
        <button className="back" onClick={onBack}>←</button>
        <span className="chat-title">{roomName}</span>
        {syncing && <span className="syncing">syncing…</span>}
      </div>

      <div className="messages" ref={messagesRef} onScroll={handleScroll}>
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
                {!msg.isOwnMessage && (
                  <div className="sender">{shortName(msg.sender)}</div>
                )}
                <div className="bubble">{msg.body}</div>
                <div className="timestamp">{formatTime(msg.timestamp)}</div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

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

      <div className="input-row">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message…"
          rows={1}
          disabled={sending}
        />
        <button onClick={() => sendMessage(input)} disabled={sending || !input.trim()}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

function eventToMessage(event: sdk.MatrixEvent, userId: string): Message {
  return {
    eventId: event.getId() ?? event.getTs().toString(),
    sender: event.getSender() ?? '',
    body: event.getContent()?.body ?? '',
    timestamp: event.getTs(),
    isOwnMessage: event.getSender() === userId,
  }
}

function eventsToMessages(events: sdk.MatrixEvent[], userId: string): Message[] {
  return events
    .filter((e) => e.getType() === 'm.room.message')
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
