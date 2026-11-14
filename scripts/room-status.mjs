// What an agent room is doing, as one room state event, so Construct reads it
// rather than guessing from the newest message (src/lib/roomStatus.ts).
//
//   {
//     "approval": { "event_id": "$card", "tool": "Bash", "agent": "Explore", "since": 1731600000000 } | null,
//     "issues": ["BEN-123"]
//   }
//
// `approval` is the card waiting on an answer, set by the bot when it posts one
// and cleared when it is answered, times out or is abandoned. `issues` is what
// the agent says it is working on (construct-issue); empty, Construct falls back
// to the issue ids in the room name. Room state is never encrypted, so this
// holds pointers and tool names only, never the command being approved.
export const ROOM_STATUS_EVENT = 'com.construct.room_status'

const ISSUE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/
const MAX_ISSUES = 5

/** The status from its state content, dropping anything malformed. */
export function parseRoomStatus(content) {
  const a = content?.approval
  const approval = a && typeof a.event_id === 'string' && a.event_id.startsWith('$') && typeof a.tool === 'string'
    ? {
        event_id: a.event_id,
        tool: a.tool,
        ...(typeof a.agent === 'string' && a.agent ? { agent: a.agent } : {}),
        since: Number.isInteger(a.since) ? a.since : 0,
      }
    : null
  const issues = normalizeIssues(content?.issues)
  return { approval, issues }
}

/** Issue ids, upper-cased, valid, once each, at most MAX_ISSUES. */
export function normalizeIssues(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const v of list) {
    if (typeof v !== 'string') continue
    const key = v.trim().toUpperCase()
    if (ISSUE.test(key) && !out.includes(key)) out.push(key)
    if (out.length >= MAX_ISSUES) break
  }
  return out
}

/**
 * The status with `patch` applied (only the keys it names), or null when
 * nothing changes, so an unchanged status is never re-sent.
 */
export function patchRoomStatus(content, patch) {
  const before = parseRoomStatus(content)
  const next = { ...before }
  if ('approval' in patch) next.approval = patch.approval ? parseRoomStatus({ approval: patch.approval }).approval : null
  if ('issues' in patch) next.issues = normalizeIssues(patch.issues)
  return JSON.stringify(next) === JSON.stringify(before) ? null : next
}
