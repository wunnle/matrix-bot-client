// Recognising "the provider stopped us", as distinct from "the turn failed".
//
// A blocked turn is not an error the agent can be asked to retry — nothing will
// work until the quota window rolls over. Construct shows a Continue working
// button for exactly this state, so the bot has to be able to tell it apart
// from every other ⚠️ and say when the wait ends.

// Matched against the failure text only (a turn that succeeded is never
// blocked), so these can stay loose without catching ordinary prose.
const BLOCKED_RE = /(usage limit reached|session limit|rate[- ]limit|quota exceeded|limit .*\bresets?\b)/i

// The CLI's machine-readable form: "Claude AI usage limit reached|1760000000".
const EPOCH_RE = /limit reached\|(\d{9,13})/i

// The human form: "You've hit your session limit · resets 1:10pm (Europe/Istanbul)".
const CLOCK_RE = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i

/**
 * Resolve a bare clock time to the next instant it occurs, from `now`.
 * The reset string carries no date — 1:10pm read at 3pm means tomorrow.
 */
function nextOccurrence(hour, minute, now) {
  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/**
 * @returns {null | {reason: string, resetsAt: number | null}} — null when the
 * turn failed for some other reason, or did not fail at all.
 */
export function detectLimitBlock(res, now = new Date()) {
  if (!res) return null
  const text = res.error ?? (res.isError ? res.text : null)
  if (!text || !BLOCKED_RE.test(text)) return null

  const reason = String(text).trim().slice(0, 300)

  const epoch = EPOCH_RE.exec(text)
  if (epoch) {
    const n = Number(epoch[1])
    // Both seconds and milliseconds appear in the wild; 1e12 is year 2001 in ms
    // and year 33658 in seconds, so the split is unambiguous.
    return { reason, resetsAt: n < 1e12 ? n * 1000 : n }
  }

  const clock = CLOCK_RE.exec(text)
  if (clock) {
    let hour = Number(clock[1])
    const minute = Number(clock[2] ?? 0)
    const mer = clock[3]?.toLowerCase()
    if (mer === 'pm' && hour < 12) hour += 12
    if (mer === 'am' && hour === 12) hour = 0
    if (hour <= 23 && minute <= 59) return { reason, resetsAt: nextOccurrence(hour, minute, now) }
  }

  // Blocked, but with no time we can trust. The button still belongs there —
  // it just cannot say when to press it.
  return { reason, resetsAt: null }
}
