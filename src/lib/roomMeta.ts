// Pills are stored in Matrix account data under this event type,
// so no room permissions are required and they sync across devices.

import type { MatrixClient } from 'matrix-js-sdk'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ACCOUNT_DATA_TYPE = 'com.matrix-pwa.room-pills' as any

interface PillsStore {
  [roomId: string]: string[]
}

export async function loadPills(client: MatrixClient, roomId: string): Promise<string[]> {
  try {
    const data = client.getAccountData(ACCOUNT_DATA_TYPE)?.getContent<PillsStore>() ?? {}
    return data[roomId] ?? []
  } catch {
    return []
  }
}

export async function savePills(client: MatrixClient, roomId: string, pills: string[]): Promise<void> {
  const existing = client.getAccountData(ACCOUNT_DATA_TYPE)?.getContent<PillsStore>() ?? {}
  await client.setAccountData(ACCOUNT_DATA_TYPE, { ...existing, [roomId]: pills } as any)
}

// m.room.create `type` set by the Claude Code bot when it spawns a room.
// Keep in sync with AGENT_ROOM_TYPE in scripts/claude-code-bot.mjs.
export const AGENT_ROOM_TYPE = 'com.construct.agent'

// The command set every agent room shares. Seeded on accept because the bot
// cannot write them: pills live in the user's account data, writable only with
// the user's own token.
// !stop leads: it is the only one that is urgent when you reach for it, and the
// row is where you look while a turn you no longer want is running.
const AGENT_PILLS = ['!stop', '!model', '!end', '!reset']

export function isAgentRoom(client: MatrixClient, roomId: string): boolean {
  const room = client.getRoom(roomId)
  const create = room?.currentState.getStateEvents('m.room.create', '')
  return create?.getContent()?.type === AGENT_ROOM_TYPE
}

/**
 * Seed the standard pills for a freshly joined agent room. No-op for ordinary
 * rooms, and never clobbers pills the user has already set for this room.
 */
export async function seedAgentPills(client: MatrixClient, roomId: string): Promise<void> {
  // joinRoom resolves before the room's state is necessarily in memory, so a
  // single check can miss the create event and silently seed nothing.
  let agent = false
  for (let attempt = 0; attempt < 5 && !agent; attempt++) {
    agent = isAgentRoom(client, roomId)
    if (!agent) await new Promise((r) => setTimeout(r, 400))
  }
  if (!agent) return
  const existing = await loadPills(client, roomId)
  if (existing.length > 0) return
  await savePills(client, roomId, AGENT_PILLS)
}
