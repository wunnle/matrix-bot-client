import * as sdk from 'matrix-js-sdk'
import type { AuthState } from '../types'

let client: sdk.MatrixClient | null = null

export function getClient(): sdk.MatrixClient {
  if (!client) throw new Error('Matrix client not initialized')
  return client
}

export function createClient(auth: AuthState): sdk.MatrixClient {
  client = sdk.createClient({
    baseUrl: auth.homeserver,
    accessToken: auth.accessToken,
    userId: auth.userId,
    deviceId: auth.deviceId,
  })
  return client
}

export function destroyClient() {
  if (client) {
    client.stopClient()
    client = null
  }
}

export interface RoomSummary {
  roomId: string
  name: string
  lastMessage?: string
  lastTs?: number
}

export async function fetchJoinedRooms(auth: AuthState): Promise<RoomSummary[]> {
  const c = createClient(auth)
  await c.startClient({ lazyLoadMembers: true })

  return new Promise((resolve) => {
    c.once(sdk.ClientEvent.Sync, (state) => {
      if (state === 'PREPARED') {
        const rooms = c.getRooms().map((room) => {
          const timeline = room.getLiveTimeline().getEvents()
          const last = [...timeline].reverse().find(
            (e) => e.getType() === 'm.room.message'
          )
          return {
            roomId: room.roomId,
            name: room.name,
            lastMessage: last?.getContent()?.body,
            lastTs: last?.getTs(),
          }
        })
        rooms.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
        resolve(rooms)
      }
    })
  })
}
