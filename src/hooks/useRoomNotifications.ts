import { useState, useEffect, useRef, useCallback } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { IRoomTimelineData } from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'

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

export interface RoomNotification {
  roomId: string
  roomName: string
  senderName: string
  body: string
  avatarMxc?: string
  receivedAt: number
}

export function useRoomNotifications(activeRoomId: string | null, clientReady: boolean) {
  // All pending notifications, one per room (keyed by roomId)
  const [notifications, setNotifications] = useState<RoomNotification[]>([])
  // Set of roomIds currently showing as in-room toasts (auto-expires after TOAST_TTL_MS)
  const [toastRoomIds, setToastRoomIds] = useState<Set<string>>(new Set())
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const activeRoomIdRef = useRef(activeRoomId)

  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  // Clear notification when its room becomes active
  useEffect(() => {
    if (!activeRoomId) return
    setNotifications(prev => prev.filter(n => n.roomId !== activeRoomId))
    setToastRoomIds(prev => { const s = new Set(prev); s.delete(activeRoomId); return s })
    const t = toastTimers.current.get(activeRoomId)
    if (t) { clearTimeout(t); toastTimers.current.delete(activeRoomId) }
  }, [activeRoomId])

  const dismiss = useCallback((roomId: string) => {
    setNotifications(prev => prev.filter(n => n.roomId !== roomId))
    setToastRoomIds(prev => { const s = new Set(prev); s.delete(roomId); return s })
    const t = toastTimers.current.get(roomId)
    if (t) { clearTimeout(t); toastTimers.current.delete(roomId) }
  }, [])

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

      // Upsert: one notification per room
      setNotifications(prev => {
        const filtered = prev.filter(n => n.roomId !== room.roomId)
        return [...filtered, notification]
      })

      // Show as in-room toast, reset timer if room already toasting
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
      toastTimers.current.forEach(t => clearTimeout(t))
    }
  }, [clientReady])

  // Toasts = notifications whose roomId is in toastRoomIds
  const toasts = notifications.filter(n => toastRoomIds.has(n.roomId))

  return { notifications, toasts, dismiss }
}
