import { useEffect, useRef, useState } from 'react'
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

export default function ChatView({ roomId, roomName, config, userId, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const client = getClient()

  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return

    // Load existing timeline
    const events = room.getLiveTimeline().getEvents()
    setMessages(eventsToMessages(events, userId))

    // Listen for new events
    const onEvent = (event: sdk.MatrixEvent, room_: sdk.Room | undefined) => {
      if (room_?.roomId !== roomId) return
      if (event.getType() !== 'm.room.message') return
      setMessages((prev) => [...prev, eventToMessage(event, userId)])
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => { client.off(sdk.RoomEvent.Timeline, onEvent) }
  }, [roomId, userId, client])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Autocomplete filtering
  useEffect(() => {
    const all = [...(config?.pills ?? []), ...(config?.suggestions ?? [])]
    if (input.trim().length < 2) {
      setSuggestions([])
      return
    }
    const q = input.toLowerCase()
    setSuggestions(all.filter((s) => s.toLowerCase().includes(q)).slice(0, 5))
  }, [input, config])

  async function sendMessage(text: string) {
    if (!text.trim()) return
    setInput('')
    setSuggestions([])
    await client.sendTextMessage(roomId, text)
  }

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
      </div>

      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.eventId} className={`message ${msg.isOwnMessage ? 'own' : 'other'}`}>
            {!msg.isOwnMessage && <div className="sender">{msg.sender}</div>}
            <div className="bubble">{msg.body}</div>
          </div>
        ))}
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
            <li key={s} onClick={() => sendMessage(s)}>{s}</li>
          ))}
        </ul>
      )}

      <div className="input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message…"
          rows={1}
        />
        <button onClick={() => sendMessage(input)}>Send</button>
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
