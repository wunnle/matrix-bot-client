import { useState, useEffect, useRef, useCallback } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { IRoomTimelineData } from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'

const TOOL_PROGRESS_LINE = /^(?:\*\s*)?\S\S?\s+\w[\w./-]*(?::\s+".{0,80}"(?:\s+\(×\d+\))?|\.\.\.)\s*$/u

function isThinkingMessage(body: string): boolean {
  return body.split('\n').filter(l => l.trim()).every(l => TOOL_PROGRESS_LINE.test(l.trim()))
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

      const content = event.getContent()
      const body = content?.body as string | undefined
      if (!body) return
      if (isThinkingMessage(body)) return

      const sender = event.getSender() ?? ''
      const member = room.getMember(sender)
      const senderName = member?.name ?? sender.split(':')[0].replace('@', '')

      const toastData: RoomToastData = {
        id: `${event.getId()}-${Date.now()}`,
        roomId: room.roomId,
        roomName: room.name,
        senderName,
        body: body.slice(0, 100),
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
