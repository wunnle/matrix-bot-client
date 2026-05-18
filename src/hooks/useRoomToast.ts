import { useState, useEffect, useRef, useCallback } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { IRoomTimelineData } from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'

export interface RoomToastData {
  roomId: string
  roomName: string
  senderName: string
  body: string
  avatarMxc?: string
}

const TOAST_DURATION = 4000

export function useRoomToast(activeRoomId: string | null, clientReady: boolean) {
  const [toast, setToast] = useState<RoomToastData | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRoomIdRef = useRef(activeRoomId)
  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  const dismiss = useCallback(() => {
    setToast(null)
    if (timerRef.current) clearTimeout(timerRef.current)
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

      const sender = event.getSender() ?? ''
      const member = room.getMember(sender)
      const senderName = member?.name ?? sender.split(':')[0].replace('@', '')

      const toastData: RoomToastData = {
        roomId: room.roomId,
        roomName: room.name,
        senderName,
        body: body.slice(0, 100),
        avatarMxc: room.getMxcAvatarUrl() ?? undefined,
      }

      setToast(toastData)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setToast(null), TOAST_DURATION)
    }

    client.on(sdk.RoomEvent.Timeline, onEvent)
    return () => {
      client.off(sdk.RoomEvent.Timeline, onEvent)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [clientReady])

  return { roomToast: toast, dismissRoomToast: dismiss }
}
