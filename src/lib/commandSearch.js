// Ranking for the ⌘K palette (CommandPalette.tsx). Plain JS so the node tests
// in scripts/test-command-search.mjs can import it without a build step.
//
// Tiers, best first:
//   4  the title starts with the query ("ben-3" → "BEN-359 Scruffy captures")
//   3  a word in the title starts with it ("scruf" → "BEN-359 Scruffy …")
//   2  the title (or a keyword) contains it, or every word of the query
//   1  loose: the query's letters appear in order ("bscr" → "BEN-359 Scruffy")
// Loose matches are noise next to real ones, so they only come back when
// nothing matches as a substring. Within a tier, the most recently active item
// wins, then the shorter title.

function norm(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim()
}

function isSubsequence(needle, hay) {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++
  return i === needle.length
}

/** 0 when the item does not match at all. */
export function matchTier(query, title, keywords = []) {
  const q = norm(query)
  if (!q) return 1
  const t = norm(title)
  if (t.startsWith(q)) return 4
  if (t.split(/[\s\-_·/:]+/).some((w) => w && w.startsWith(q))) return 3
  const fields = [t, ...keywords.map(norm)]
  if (fields.some((f) => f.includes(q))) return 2
  const words = q.split(/\s+/).filter(Boolean)
  const all = fields.join(' ')
  if (words.length > 1 && words.every((w) => all.includes(w))) return 2
  const squashed = q.replace(/\s+/g, '')
  if (fields.some((f) => isSubsequence(squashed, f))) return 1
  return 0
}

/**
 * For free text like a message: the whole query, or every word of it, appears
 * somewhere. No loose matching — in a page of text nearly anything is a
 * subsequence of something.
 */
export function textMatches(query, text) {
  const q = norm(query)
  if (!q) return false
  const t = norm(text)
  return t.includes(q) || q.split(/\s+/).every((w) => t.includes(w))
}

/**
 * The part of `text` around the first match, on one line, at most `max`
 * characters, with an ellipsis where it was cut.
 */
export function snippet(text, query, max = 90) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const q = norm(query)
  const lower = flat.toLowerCase()
  let at = lower.indexOf(q)
  if (at < 0) at = q.split(/\s+/).map((w) => lower.indexOf(w)).find((i) => i >= 0) ?? 0
  // A little lead-in before the match, so it reads as a sentence.
  let start = Math.max(0, at - Math.floor(max / 4))
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space > 0 && space < at) start = space + 1
  }
  const end = Math.min(flat.length, start + max)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

/**
 * Items matching `query`, best first. An item is {title, keywords?, recency?}
 * plus whatever the caller needs; `recency` is a timestamp (higher = newer).
 */
export function rankCommands(items, query, limit = 50) {
  const scored = []
  for (const item of items) {
    const tier = matchTier(query, item.title, item.keywords)
    if (tier > 0) scored.push({ item, tier })
  }
  const strong = scored.some((s) => s.tier >= 2)
  return scored
    .filter((s) => !strong || s.tier >= 2)
    .sort((a, b) =>
      b.tier - a.tier
      || (b.item.recency ?? 0) - (a.item.recency ?? 0)
      || a.item.title.length - b.item.title.length
      || a.item.title.localeCompare(b.item.title))
    .slice(0, limit)
    .map((s) => s.item)
}
