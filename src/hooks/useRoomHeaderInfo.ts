import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { getRoomBotMeta, shortenTopicPaths } from '../lib/chatRoom'

/** What the chat header shows about a room: its bot (the first other member),
 *  its topic and its avatar, each kept current from room state. */
export function useRoomHeaderInfo(client: sdk.MatrixClient, roomId: string, userId: string) {
  const [bot, setBot] = useState<{ name: string; avatarUrl: string | null } | null>(null)
  const [roomAvatarUrl, setRoomAvatarUrl] = useState<string | null>(null)
  const [roomTopic, setRoomTopic] = useState('')

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
    // On the room, not room.currentState — see useAgentBlocked for why.
    room.on(sdk.RoomStateEvent.Members, onMembers)
    room.on(sdk.RoomEvent.CurrentStateUpdated, update)
    return () => {
      cancelled = true
      room.off(sdk.RoomStateEvent.Members, onMembers)
      room.off(sdk.RoomEvent.CurrentStateUpdated, update)
    }
  }, [roomId, userId, client])

  // m.room.topic for subtitle (when non-empty); listen for state updates
  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) {
      setRoomTopic('')
      return
    }
    const readTopic = () => {
      const ev = room.currentState.getStateEvents(sdk.EventType.RoomTopic, '')
      const raw = ev?.getContent()?.topic
      const t = typeof raw === 'string' ? raw.trim() : ''
      setRoomTopic(shortenTopicPaths(t))
    }
    readTopic()
    const onState = (ev: sdk.MatrixEvent) => {
      if (ev.getRoomId() !== roomId) return
      if (ev.getType() === sdk.EventType.RoomTopic) readTopic()
    }
    room.on(sdk.RoomStateEvent.Events, onState)
    room.on(sdk.RoomEvent.CurrentStateUpdated, readTopic)
    return () => {
      room.off(sdk.RoomStateEvent.Events, onState)
      room.off(sdk.RoomEvent.CurrentStateUpdated, readTopic)
    }
  }, [roomId, client])

  // Resolve room's own avatar URL
  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) return
    const mxcUrl = room.getMxcAvatarUrl()
    if (!mxcUrl) { setRoomAvatarUrl(null); return }
    let cancelled = false
    resolveMediaUrl(client, mxcUrl, 80, 80, 'crop').then(url => {
      if (!cancelled) setRoomAvatarUrl(url ?? null)
    })
    return () => { cancelled = true }
  }, [roomId, client])

  return { bot, roomTopic, roomAvatarUrl }
}
