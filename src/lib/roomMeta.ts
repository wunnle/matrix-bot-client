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
// !auto sits after the two you reach for mid-turn and before the two that end
// things; it is a setting, not an interruption.
const AGENT_PILLS = ['!stop', '!model', '!auto', '!end', '!reset']

// A default added after rooms already exist reaches nobody: pills are seeded
// once, on accept. Backfilling has to be a one-shot migration rather than a
// reconcile against AGENT_PILLS on every sync — otherwise a pill the user
// deliberately deleted grows back the next time the app starts.
//
// Recorded under a key that cannot collide with a room id, since those always
// begin with '!'.
const MIGRATIONS_KEY = '__migrations'
// Each entry adds one pill to rooms that already have a row, once. `at: 'start'`
// is for pills you reach for in a hurry — appending would bury them behind
// whatever the user has added since.
const PILL_MIGRATIONS: { id: string; pill: string; at: 'start' | 'end' }[] = [
  { id: 'stop-pill', pill: '!stop', at: 'start' },
  { id: 'auto-pill', pill: '!auto', at: 'end' },
]

export async function backfillAgentPills(client: MatrixClient): Promise<void> {
  const store = client.getAccountData(ACCOUNT_DATA_TYPE)?.getContent<PillsStore>() ?? {}
  const done = store[MIGRATIONS_KEY] ?? []
  const pending = PILL_MIGRATIONS.filter((m) => !done.includes(m.id))
  if (!pending.length) return

  const next: PillsStore = { ...store }
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== 'join') continue
    if (!isAgentRoom(client, room.roomId)) continue
    for (const { pill, at } of pending) {
      const pills = next[room.roomId]
      // An agent room with no pills yet is seedAgentPills' job — it lays down
      // the full set, so touching it here would only half-seed it.
      if (!pills?.length || pills.includes(pill)) continue
      next[room.roomId] = at === 'start' ? [pill, ...pills] : [...pills, pill]
    }
  }
  next[MIGRATIONS_KEY] = [...done, ...pending.map((m) => m.id)]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.setAccountData(ACCOUNT_DATA_TYPE, next as any)
}

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
