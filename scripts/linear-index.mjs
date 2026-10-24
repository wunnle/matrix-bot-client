// The Linear issues a room has talked about, as room state, so Construct's
// sidebar lists them however little history it has loaded (src/hooks/useLinearIndex.ts).
// Room state is never encrypted, so it carries pointers only: the issue key and
// the message that last mentioned it. Titles, states and projects come live
// from /api/linear; an issue's project needs no entry of its own.
export const LINEAR_INDEX_EVENT = 'com.construct.linear'

// The teams actually used, as in src/lib/roomMedia.ts: a generic [A-Z]+-\d+
// also matches UTF-8, SHA-256, ISO-8601.
const LINEAR_TEAMS = ['BEN']
const KEY = new RegExp(`\\b((?:${LINEAR_TEAMS.join('|')})-\\d{1,5})\\b`, 'g')
const ISSUE_URL = /https:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]*-\d{1,6})/gi
const MAX = 100

/** The issue keys a message names, by key or by link, in order, once each. */
export function issueKeys(text) {
  if (typeof text !== 'string' || !text) return []
  const found = new Set()
  for (const m of text.matchAll(ISSUE_URL)) found.add(m[1].toUpperCase())
  for (const m of text.replace(ISSUE_URL, '').matchAll(KEY)) found.add(m[1])
  return [...found]
}

/** The index's entries from its state content, dropping anything malformed. */
export function parseLinearIndex(content) {
  const list = content?.issues
  if (!Array.isArray(list)) return []
  return list.filter((e) => typeof e?.key === 'string' && typeof e.eventId === 'string' && e.eventId.startsWith('$'))
    .map((e) => ({ key: e.key, eventId: e.eventId, at: Number.isInteger(e.at) ? e.at : 0 }))
}

/**
 * The index with `keys` mentioned by `eventId` at `ts`: those move to the
 * front, newest first, and the oldest fall off past MAX. Integers only, as
 * everywhere in event content. null when nothing changes.
 */
export function withMentions(content, keys, eventId, ts) {
  if (!keys.length) return null
  const at = Math.round(ts)
  const before = parseLinearIndex(content)
  const prev = new Map(before.map((e) => [e.key, e]))
  const mentioned = new Set(keys)
  const issues = [
    // A streamed reply is edited over and over; its mention dates from the first.
    ...keys.map((key) => (prev.get(key)?.eventId === eventId ? prev.get(key) : { key, eventId, at })),
    ...before.filter((e) => !mentioned.has(e.key)),
  ].slice(0, MAX)
  if (JSON.stringify(issues) === JSON.stringify(before)) return null
  return { issues }
}
