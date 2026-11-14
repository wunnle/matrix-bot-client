// What an agent room is doing, as one room state event, so Construct reads it
// rather than guessing from the newest message (src/lib/roomStatus.ts).
//
//   {
//     "approval": { "event_id": "$card", "tool": "Bash", "agent": "Explore", "since": 1731600000000 } | null,
//     "issues": ["BEN-123"],
//     "activity": { "phase": "tool", "tool": "terminal", "since": 1731600000000, "turn_since": 1731599990000 } | null,
//     "plan": { "event_id": "$plan" } | null
//   }
//
// `plan` points at the newest com.construct.plan event (room-plan.mjs), which
// holds the steps; they are the agent's words, so they stay out of state.
//
// `activity` is what the turn is doing right now, as the bot knows it: the
// model working ("thinking"), a tool running ("tool", by its progress name),
// or the answer sent with background work still running ("background"); null
// when no turn is running. `since` is when that phase began, `turn_since` when
// the turn did. Construct shows this instead of guessing from the timeline.
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
  return { approval, issues, activity: parseActivity(content?.activity), plan: parsePlanPointer(content?.plan) }
}

// The newest plan event (room-plan.mjs); its steps live there, encrypted.
function parsePlanPointer(p) {
  return p && typeof p.event_id === 'string' && p.event_id.startsWith('$') ? { event_id: p.event_id } : null
}

const PHASES = new Set(['thinking', 'tool', 'background'])

function parseActivity(a) {
  if (!a || !PHASES.has(a.phase)) return null
  const since = Number.isInteger(a.since) ? a.since : 0
  return {
    phase: a.phase,
    ...(a.phase === 'tool' && typeof a.tool === 'string' && a.tool ? { tool: a.tool.slice(0, 40) } : {}),
    since,
    turn_since: Number.isInteger(a.turn_since) ? a.turn_since : since,
  }
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
  if ('activity' in patch) next.activity = parseActivity(patch.activity)
  if ('plan' in patch) next.plan = parsePlanPointer(patch.plan)
  return JSON.stringify(next) === JSON.stringify(before) ? null : next
}
