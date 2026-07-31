// Which rooms are excluded from the iOS share sheet's direct-share targets.
// Stored per-device (localStorage) as the DISABLED set, so rooms default to
// enabled and newly-joined rooms show up automatically.

const KEY = (userId: string) => `construct:share-disabled:${userId}`

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
