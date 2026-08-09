import { useState, useEffect, useRef, useCallback } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { IRoomTimelineData } from 'matrix-js-sdk'
import { getClient, getRoomUnreadCount } from '../lib/matrix'

const TOOL_PROGRESS_LINE = /^(?:\*\s*)?\S\S?\s+\w[\w./-]*(?::\s+".{0,80}"(?:\s+\(×\d+\))?|\.\.\.)\s*$/u
const TOAST_TTL_MS = 4000

function isThinkingMessage(body: string): boolean {
  return body.split('\n').filter(l => l.trim()).every(l => TOOL_PROGRESS_LINE.test(l.trim()))
}

function toastBody(raw: string): string {
  let text = raw.replace(/```[\s\S]*?```/g, '[code]')
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? text.trim()
  return firstLine.slice(0, 120)
}

function notifFromRoom(room: sdk.Room, userId: string): RoomNotification | null {
  const events = room.getLiveTimeline().getEvents()
  const lastMsg = [...events].reverse().find(
    e => (e.getType() === 'm.room.message') && !e.isDecryptionFailure() && e.getSender() !== userId
  )
  if (!lastMsg) return null
  const lastContent = lastMsg.getContent()
  // See useRoomToast: machine messages are plumbing, not someone talking.
  if (lastContent?.['com.construct.machine']) return null
  const body = lastContent?.body as string | undefined
  if (!body || isThinkingMessage(body)) return null
  const sender = lastMsg.getSender() ?? ''
  const member = room.getMember(sender)
  return {
    roomId: room.roomId,
    roomName: room.name,
    senderName: member?.name ?? sender.split(':')[0].replace('@', ''),
    body: toastBody(body),
    avatarMxc: room.getMxcAvatarUrl() ?? undefined,
    receivedAt: lastMsg.getTs(),
  }
}

export interface RoomNotification {
  roomId: string
  roomName: string
  senderName: string
  body: string
  avatarMxc?: string
  receivedAt: number
}

export function useRoomNotifications(activeRoomId: string | null, clientReady: boolean, userId: string) {
  const [notifications, setNotifications] = useState<RoomNotification[]>([])
  const [toastRoomIds, setToastRoomIds] = useState<Set<string>>(new Set())
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const activeRoomIdRef = useRef(activeRoomId)

  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

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
    setToastRoomIds(prev => { const s = new Set(prev); s.delete(activeRoomId); return s })
    const t = toastTimers.current.get(activeRoomId)
    if (t) { clearTimeout(t); toastTimers.current.delete(activeRoomId) }
  }, [activeRoomId])

  // Dismiss = remove notification + send read receipt so badge clears too
  const dismiss = useCallback((roomId: string) => {
    setNotifications(prev => prev.filter(n => n.roomId !== roomId))
    setToastRoomIds(prev => { const s = new Set(prev); s.delete(roomId); return s })
    const t = toastTimers.current.get(roomId)
    if (t) { clearTimeout(t); toastTimers.current.delete(roomId) }

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
  }, [])

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

      const sender = event.getSender() ?? ''
      if (sender === client.getUserId()) return

      const content = event.getContent()
      if (content?.['com.construct.machine']) return
      const body = content?.body as string | undefined
      if (!body) return
      if (isThinkingMessage(body)) return

      const member = room.getMember(sender)
      const senderName = member?.name ?? sender.split(':')[0].replace('@', '')

      const notification: RoomNotification = {
        roomId: room.roomId,
        roomName: room.name,
        senderName,
        body: toastBody(body),
        avatarMxc: room.getMxcAvatarUrl() ?? undefined,
        receivedAt: Date.now(),
      }

      setNotifications(prev => {
        const filtered = prev.filter(n => n.roomId !== room.roomId)
        return [...filtered, notification]
      })

      const existing = toastTimers.current.get(room.roomId)
      if (existing) clearTimeout(existing)
      setToastRoomIds(prev => new Set([...prev, room.roomId]))
      const timer = setTimeout(() => {
        setToastRoomIds(prev => { const s = new Set(prev); s.delete(room.roomId); return s })
        toastTimers.current.delete(room.roomId)
      }, TOAST_TTL_MS)
      toastTimers.current.set(room.roomId, timer)
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onEvent)
      toastTimers.current.forEach(clearTimeout)
    }
  }, [clientReady])

  const toasts = notifications.filter(n => toastRoomIds.has(n.roomId))
  return { notifications, toasts, dismiss }
}
