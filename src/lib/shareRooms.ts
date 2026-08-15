// Which rooms are excluded from the iOS share sheet's direct-share targets.
// Stored per-device (localStorage) as the DISABLED set, so rooms default to
// enabled and newly-joined rooms show up automatically.
import { getClient } from './matrix'
import { isAgentRoom } from './roomMeta'

const KEY = (userId: string) => `construct:share-disabled:${userId}`

// Agent rooms are never share targets, and this is not a preference. Defaulting
// to enabled is right for rooms with people in them, but every spawned agent
// room would then appear in the share sheet the moment it is created — and they
// are created often enough that the sheet fills with BenderDev-N. Sharing a
// photo into a coding agent is not a thing anyone wants to do.
//
// Excluded rather than merely defaulted-off so it keeps holding for rooms that
// do not exist yet, without anyone having to maintain the disabled set.
export function isShareableRoom(roomId: string): boolean {
  try {
    return !isAgentRoom(getClient(), roomId)
  } catch {
    // No client yet: say nothing is shareable rather than donating an agent
    // room by accident. The donation re-runs once the client is up.
    return false
  }
}

export function getDisabledShareRooms(userId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY(userId)) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function setDisabledShareRooms(userId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(KEY(userId), JSON.stringify([...ids]))
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
