import { useState, useEffect, useRef, useCallback } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { IRoomTimelineData } from 'matrix-js-sdk'
import { getClient, getRoomUnreadCount, isThinkingMessage } from '../lib/matrix'
import { parseActions } from '../lib/actions'

// How long a toast stays up. One offering [[pills]] is waiting on an answer,
// so it gets long enough to actually be answered. Approvals have no timer at
// all: one that scrolls away unseen times out as a denial.
const TOAST_TTL_MS = 4000
const TOAST_TTL_ACTIONS_MS = 30_000

const FENCE = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g

function toastBody(raw: string): string {
  let text = raw.replace(/```[\s\S]*?```/g, '[code]')
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? text.trim()
  return firstLine.slice(0, 120)
}

/** The toast's richer view of a message: a few lines of prose, the first code
    block as a snippet, and the [[CTA]] buttons. */
function toastParts(raw: string): Pick<RoomNotification, 'lines' | 'code' | 'actions'> {
  const { text, actions } = parseActions(raw)
  FENCE.lastIndex = 0
  const fence = FENCE.exec(text)
  const code = fence
    ? fence[2].replace(/\n+$/, '').split('\n').slice(0, 4).join('\n')
    : undefined
  const lines = text
    .replace(FENCE, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map(l => l.slice(0, 160))
  return { lines, code: code || undefined, actions: actions.slice(0, 3) }
}

/** An agent asking to run a tool: the bot posts these with a 🔐 heading, plus
    the full change as com.construct.approval when the card clips it. */
function approvalInfo(content: Record<string, unknown>, body: string): RoomNotification['approval'] {
  const full = content['com.construct.approval'] as { lines?: unknown } | undefined
  if (!full && !body.trimStart().startsWith('🔐 Approve')) return undefined
  const lines = Number(full?.lines)
  return { lines: Number.isFinite(lines) && lines > 0 ? lines : undefined }
}

function toNotification(room: sdk.Room, event: sdk.MatrixEvent, receivedAt: number): RoomNotification | null {
  const content = event.getContent()
  // Machine messages are plumbing, not someone talking.
  if (content?.['com.construct.machine']) return null
  const body = content?.body as string | undefined
  if (!body || isThinkingMessage(body)) return null
  const sender = event.getSender() ?? ''
  const member = room.getMember(sender)
  return {
    roomId: room.roomId,
    eventId: event.getId() ?? `${room.roomId}-${receivedAt}`,
    roomName: room.name,
    senderName: member?.name ?? sender.split(':')[0].replace('@', ''),
    body: toastBody(body),
    ...toastParts(body),
    approval: approvalInfo(content, body),
    avatarMxc: room.getMxcAvatarUrl() ?? undefined,
    receivedAt,
  }
}

function notifFromRoom(room: sdk.Room, userId: string): RoomNotification | null {
  const events = room.getLiveTimeline().getEvents()
  const lastMsg = [...events].reverse().find(
    e => (e.getType() === 'm.room.message') && !e.isDecryptionFailure() && e.getSender() !== userId
  )
  if (!lastMsg) return null
  return toNotification(room, lastMsg, lastMsg.getTs())
}

export interface RoomNotification {
  roomId: string
  eventId: string
  roomName: string
  senderName: string
  /** One-line summary, for the sidebar notification center. */
  body: string
  /** Up to three lines of prose for the toast, [[CTA]] markers removed. */
  lines: string[]
  /** First few lines of the message's first code block. */
  code?: string
  /** [[CTA]] labels, sent back verbatim when tapped. */
  actions: string[]
  /** Set when this is a tool-approval request. */
  approval?: { lines?: number }
  avatarMxc?: string
  receivedAt: number
}

export function useRoomNotifications(activeRoomId: string | null, clientReady: boolean, userId: string) {
  const [notifications, setNotifications] = useState<RoomNotification[]>([])
  const [toastRoomIds, setToastRoomIds] = useState<Set<string>>(new Set())
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const activeRoomIdRef = useRef(activeRoomId)
  const notificationsRef = useRef(notifications)
  useEffect(() => { notificationsRef.current = notifications }, [notifications])
  const toastRoomIdsRef = useRef(toastRoomIds)
  useEffect(() => { toastRoomIdsRef.current = toastRoomIds }, [toastRoomIds])

  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  const clearTimer = useCallback((roomId: string) => {
    const t = toastTimers.current.get(roomId)
    if (t) { clearTimeout(t); toastTimers.current.delete(roomId) }
  }, [])

  const hideToast = useCallback((roomId: string) => {
    clearTimer(roomId)
    setToastRoomIds(prev => {
      if (!prev.has(roomId)) return prev
      const s = new Set(prev); s.delete(roomId); return s
    })
  }, [clearTimer])

  /** (Re)start the auto-hide timer for a room's toast. Approvals get none. */
  const armTimer = useCallback((n: RoomNotification) => {
    clearTimer(n.roomId)
    if (n.approval) return
    const ms = n.actions.length ? TOAST_TTL_ACTIONS_MS : TOAST_TTL_MS
    toastTimers.current.set(n.roomId, setTimeout(() => hideToast(n.roomId), ms))
  }, [clearTimer, hideToast])

  // Seed from existing unread rooms on initial ready
  useEffect(() => {
    if (!clientReady) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }

    const initial: RoomNotification[] = []
    for (const room of client.getRooms()) {
      if (room.roomId === activeRoomId) continue
      if (getRoomUnreadCount(room, userId) === 0) continue
      const n = notifFromRoom(room, userId)
      if (n) initial.push(n)
    }
    // Sort oldest first so newest appears at bottom
    initial.sort((a, b) => a.receivedAt - b.receivedAt)
    setNotifications(initial)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientReady])

  // Clear notification when its room becomes active
  useEffect(() => {
    if (!activeRoomId) return
    setNotifications(prev => prev.filter(n => n.roomId !== activeRoomId))
    hideToast(activeRoomId)
  }, [activeRoomId, hideToast])

  // Dismiss = remove notification + send read receipt so badge clears too
  const dismiss = useCallback((roomId: string) => {
    setNotifications(prev => prev.filter(n => n.roomId !== roomId))
    hideToast(roomId)

    try {
      const client = getClient()
      const room = client.getRoom(roomId)
      if (!room) return
      const events = room.getLiveTimeline().getEvents()
      const lastEvent = [...events].reverse().find(e =>
        e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted'
      )
      if (lastEvent) client.sendReadReceipt(lastEvent).catch(() => {})
    } catch {}
  }, [hideToast])

  /** Hovering a toast holds it; leaving starts its timer over. */
  const hold = useCallback((roomId: string, held: boolean) => {
    if (held) { clearTimer(roomId); return }
    const n = notificationsRef.current.find(x => x.roomId === roomId)
    if (n) armTimer(n)
  }, [clearTimer, armTimer])

  /** A toast button: send its label to that room, exactly as tapping the pill
      in the chat would, then clear the toast. Throws so the card can show
      the failure and stay up. */
  const respond = useCallback(async (roomId: string, label: string) => {
    const client = getClient()
    // Same content as ChatView's sendMessage. The com.construct.* keys aren't
    // in the SDK's content type, hence the cast.
    await client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: label,
      'com.construct.capabilities': ['actionable'],
      'com.construct.client': 'construct-web',
      'com.construct.version': __CONSTRUCT_VERSION__,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    dismiss(roomId)
  }, [dismiss])

  // Live event listener
  useEffect(() => {
    if (!clientReady) return
    let client: ReturnType<typeof getClient>
    try { client = getClient() } catch { return }

    const onEvent = (
      event: sdk.MatrixEvent,
      room: sdk.Room | undefined,
      _toStart: boolean | undefined,
      _removed: boolean,
      data: IRoomTimelineData,
    ) => {
      if (!data?.liveEvent) return
      if (!room) return
      if (room.roomId === activeRoomIdRef.current) return
      if (event.getType() !== 'm.room.message') return
      if (event.isDecryptionFailure()) return

      // You answered in that room — from the other device, or the chat itself.
      // Whatever the toast was asking has been dealt with.
      if (event.getSender() === client.getUserId()) {
        setNotifications(prev => prev.filter(n => n.roomId !== room.roomId))
        hideToast(room.roomId)
        return
      }

      // A streamed reply arrives as edits of one message. An edit refreshes the
      // toast still showing that message; it never pops a new one.
      const rel = event.getRelation()
      if (rel?.rel_type === 'm.replace') {
        const target = rel.event_id
        const newContent = event.getContent()['m.new_content']
        const shown = notificationsRef.current.find(n => n.eventId === target)
        if (!target || !newContent || !shown || !toastRoomIdsRef.current.has(room.roomId)) return
        const fake = new sdk.MatrixEvent({
          type: 'm.room.message', sender: event.getSender(), event_id: target, content: newContent,
        })
        const updated = toNotification(room, fake, shown.receivedAt)
        if (updated) setNotifications(prev => prev.map(n => (n.eventId === target ? updated : n)))
        return
      }

      const notification = toNotification(room, event, Date.now())
      if (!notification) return

      setNotifications(prev => {
        const filtered = prev.filter(n => n.roomId !== room.roomId)
        return [...filtered, notification]
      })
      setToastRoomIds(prev => new Set([...prev, room.roomId]))
      armTimer(notification)
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onEvent)
      toastTimers.current.forEach(clearTimeout)
    }
  }, [clientReady, armTimer, hideToast])

  const toasts = notifications.filter(n => toastRoomIds.has(n.roomId))
  return { notifications, toasts, dismiss, hold, respond }
}
