import { useState, useEffect, useRef, useCallback } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { IRoomTimelineData } from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'

const TOOL_PROGRESS_LINE = /^(?:\*\s*)?\S\S?\s+\w[\w./-]*(?::\s+".{0,80}"(?:\s+\(×\d+\))?|\.\.\.)\s*$/u

function isThinkingMessage(body: string): boolean {
  return body.split('\n').filter(l => l.trim()).every(l => TOOL_PROGRESS_LINE.test(l.trim()))
}

function toastBody(raw: string): string {
  // Replace fenced code blocks with a placeholder
  let text = raw.replace(/```[\s\S]*?```/g, '[code]')
  // Collapse to first non-empty line for single-line preview
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? text.trim()
  return firstLine.slice(0, 120)
}

export interface RoomToastData {
  id: string
  roomId: string
  roomName: string
  senderName: string
  body: string
  avatarMxc?: string
}

export function useRoomToast(activeRoomId: string | null, clientReady: boolean) {
  const [toasts, setToasts] = useState<RoomToastData[]>([])
  const activeRoomIdRef = useRef(activeRoomId)
  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  const dismissTop = useCallback(() => {
    setToasts((prev) => prev.slice(0, -1))
  }, [])

  const dismissAll = useCallback(() => {
    setToasts([])
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
      // Machine messages are notifications a component emitted, not someone
      // talking. Toasting them means being interrupted by the plumbing — the
      // note watcher announcing a file changed is not worth a popup.
      if (content?.['com.construct.machine']) return
      const body = content?.body as string | undefined
      if (!body) return
      if (isThinkingMessage(body)) return
      const member = room.getMember(sender)
      const senderName = member?.name ?? sender.split(':')[0].replace('@', '')

      const toastData: RoomToastData = {
        id: `${event.getId()}-${Date.now()}`,
        roomId: room.roomId,
        roomName: room.name,
        senderName,
        body: toastBody(body),
        avatarMxc: room.getMxcAvatarUrl() ?? undefined,
      }

      setToasts((prev) => [...prev, toastData])
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onEvent)
    }
  }, [clientReady])

  return { toasts, dismissTop, dismissAll }
}
