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
//
// Room version 12 changed the shape: creators hold an implicit infinite level
// and may not be listed in power_levels at all, so the list's top was whoever
// else got 100 — usually Sinan, which made the bot that created the room (the
// Colonist room, 2026-10-21) render as a peer in its own room.
export function getRoomOwners(room: sdk.Room | undefined): Set<string> {
  const owners = new Set<string>()
  if (!room) return owners
  const creators = privilegedCreators(room)
  if (creators.length) return new Set(creators)
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

// Versions 1–11 rank creators by power level like anyone else; from 12 on
// (including its unstable hydra id) the creator and `additional_creators` sit
// above every listed level. Empty for older rooms.
const LEGACY_VERSIONS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])

function privilegedCreators(room: sdk.Room): string[] {
  const create = room.currentState?.getStateEvents('m.room.create', '')
  if (!create) return []
  const content = create.getContent() ?? {}
  const version = String(content.room_version ?? '1')
  if (LEGACY_VERSIONS.has(version)) return []
  const extra = Array.isArray(content.additional_creators) ? content.additional_creators : []
  // A room Sinan created himself is owned by whichever bot he gave the top
  // listed level, as before; his own messages never render as peers anyway.
  return [create.getSender(), ...extra].filter(
    (id): id is string => typeof id === 'string' && id.length > 0 && id !== room.myUserId,
  )
}
