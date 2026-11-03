export function shortName(userId: string): string {
  return userId.replace(/^@/, '').split(':')[0]
}

export function shortUserId(userId: string): string {
  return userId.replace(/^@/, '').split(':')[0] ?? userId
}

export function sameDay(a: number, b: number): boolean {
  const da = new Date(a), db = new Date(b)
  return da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

// "Today at 14:23" / "3 August at 14:23" — reuses formatDate so the day label
// reads the same as the timeline's date dividers.
export function formatSentAt(ts: number): string {
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${formatDate(ts)} at ${time}`
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
