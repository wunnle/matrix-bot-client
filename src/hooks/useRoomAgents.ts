import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { getRoomOwners } from '../lib/roomOwners'
import { resolveMediaUrl } from '../lib/mediaUrl'

export interface RoomAgents {
  /** More than one agent answers in this room (e.g. the Lobby), so rows say who's talking. */
  multi: boolean
  /** Agent user id → resolved avatar URL, for the agents that have one. */
  avatars: Record<string, string>
}

const NONE: RoomAgents = { multi: false, avatars: {} }

/**
 * The room's agents: every owner (top power level, see getRoomOwners) other
 * than you. One agent is the normal room and needs no attribution; with
 * several, ChatView puts each agent's avatar beside its messages.
 */
export function useRoomAgents(client: sdk.MatrixClient, roomId: string, userId: string): RoomAgents {
  const [agents, setAgents] = useState<RoomAgents>(NONE)

  useEffect(() => {
    const room = client.getRoom(roomId)
    if (!room) { setAgents(NONE); return }
    let cancelled = false
    const update = async () => {
      const ids = [...getRoomOwners(room)].filter((id) => id !== userId)
      if (ids.length < 2) {
        if (!cancelled) setAgents((prev) => (prev.multi ? NONE : prev))
        return
      }
      const pairs = await Promise.all(ids.map(async (id) => {
        const mxc = room.getMember(id)?.getMxcAvatarUrl()
        const url = mxc ? await resolveMediaUrl(client, mxc, 64, 64, 'crop').catch(() => null) : null
        return [id, url] as const
      }))
      if (cancelled) return
      const avatars: Record<string, string> = {}
      for (const [id, url] of pairs) if (url) avatars[id] = url
      setAgents((prev) => {
        const same = prev.multi && Object.keys(prev.avatars).length === Object.keys(avatars).length
          && Object.entries(avatars).every(([id, url]) => prev.avatars[id] === url)
        return same ? prev : { multi: true, avatars }
      })
    }
    void update()
    room.loadMembersIfNeeded().then(update).catch(() => {})
    room.on(sdk.RoomStateEvent.Members, update)
    room.on(sdk.RoomEvent.CurrentStateUpdated, update)
    return () => {
      cancelled = true
      room.off(sdk.RoomStateEvent.Members, update)
      room.off(sdk.RoomEvent.CurrentStateUpdated, update)
    }
  }, [roomId, userId, client])

  return agents
}
