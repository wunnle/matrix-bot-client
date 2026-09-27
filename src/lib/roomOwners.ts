import type * as sdk from 'matrix-js-sdk'

// Whoever holds the *top* power level owns the room; their messages keep the
// plain full-width bot styling and everyone else is a peer.
//
// Deliberately relative, not `=== 100`: the top level is not always the bot.
// In the Notes room the bot sits at 0 and another agent holds 100, so a
// hardcoded check would label the actual bot a peer and vice versa.
//
// Falls back to "no peers" whenever the answer is not clear-cut — an absent
// power_levels event, or one with no `users` entries — so a room that does not
// fit this shape renders exactly as it did before.
export function getRoomOwners(room: sdk.Room | undefined): Set<string> {
  const owners = new Set<string>()
  if (!room) return owners
  const pl = room.currentState?.getStateEvents('m.room.power_levels', '')
  const users = (pl?.getContent()?.users ?? {}) as Record<string, number>
  let top = -Infinity
  for (const level of Object.values(users)) {
    if (typeof level === 'number' && level > top) top = level
  }
  if (top === -Infinity) return owners
  for (const [id, level] of Object.entries(users)) {
    if (level === top) owners.add(id)
  }
  return owners
}
