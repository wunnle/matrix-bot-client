import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { getRoomOwners } from '../lib/roomOwners'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { avatarTint, hashTint } from '../lib/avatarTint'

export interface RoomAgents {
  /** More than one agent answers in this room (e.g. the Lobby), so rows say who's talking. */
  multi: boolean
  /** Agent user id → resolved avatar URL, for the agents that have one. */
  avatars: Record<string, string>
  /** Agent user id → "H S%" tint for its bubbles (from its avatar, else its id). */
  tints: Record<string, string>
}

const NONE: RoomAgents = { multi: false, avatars: {}, tints: {} }

const sameMap = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v)

/**
 * The room's agents: every owner (top power level, see getRoomOwners) other
 * than you. One agent is the normal room and needs no attribution; with
 * several, ChatView puts each agent's avatar beside its messages and tints its
 * bubbles in the avatar's colour.
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
      const triples = await Promise.all(ids.map(async (id) => {
        const mxc = room.getMember(id)?.getMxcAvatarUrl()
        const url = mxc ? await resolveMediaUrl(client, mxc, 64, 64, 'crop').catch(() => null) : null
        const tint = (url ? await avatarTint(url) : null) ?? hashTint(id)
        return [id, url, tint] as const
      }))
      if (cancelled) return
      const avatars: Record<string, string> = {}
      const tints: Record<string, string> = {}
      for (const [id, url, tint] of triples) {
        if (url) avatars[id] = url
        tints[id] = tint
      }
      setAgents((prev) => (prev.multi && sameMap(prev.avatars, avatars) && sameMap(prev.tints, tints)
        ? prev
        : { multi: true, avatars, tints }))
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
