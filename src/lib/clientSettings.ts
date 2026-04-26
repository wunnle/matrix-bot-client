function key(userId: string): string {
  return `construct:dictationAutoSend:${userId}`
}

/** Default: manual send (mic does not auto-send after silence). */
export function getDictationAutoSend(userId: string): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    const raw = localStorage.getItem(key(userId))
    if (raw === null) return false
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

export function setDictationAutoSend(userId: string, value: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key(userId), value ? '1' : '0')
  } catch {
    /* quota / private mode */
  }
}
