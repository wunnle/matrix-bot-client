/**
 * What an agent room is doing, as the bot publishes it in room state
 * (scripts/room-status.mjs): the approval card waiting on you, if any, the
 * Linear issue(s) the agent says it is working on, and what its turn is doing.
 *
 * Read from state, not from the newest message, so tool lines, subagent cards
 * or a late reply can neither hide a waiting card nor bring an answered one back.
 */
export const ROOM_STATUS_EVENT = 'com.construct.room_status'

export interface RoomStatusApproval {
  /** The card's event id. */
  eventId: string
  tool: string
  agent?: string
  /** Epoch ms the card went up. */
  since: number
}

/** What the running turn is doing, as the bot knows it. */
export interface RoomActivity {
  /** 'thinking' = the model has the turn; 'tool' = a tool is running;
   *  'background' = it answered, background work still running. */
  phase: 'thinking' | 'tool' | 'background'
  /** The tool's progress name ("terminal", "edit"), while one runs. */
  tool?: string
  /** Epoch ms this phase began. */
  since: number
  /** Epoch ms the turn began. */
  turnSince: number
}

export interface RoomStatus {
  approval: RoomStatusApproval | null
  /** As the agent set them with construct-issue; empty when it hasn't. */
  issues: string[]
  /** null = no turn running; undefined = this bot doesn't say (yet), so
   *  the timeline is all there is to go by. */
  activity: RoomActivity | null | undefined
  /** The newest plan event (its steps are encrypted there); null = no plan. */
  planEventId: string | null
  /** Epoch ms of the state event: anything newer than this, it hasn't heard of. */
  at: number
}

const ISSUE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/

export function parseRoomStatus(content: unknown, at: number): RoomStatus {
  const c = (content ?? {}) as Record<string, unknown>
  const a = c.approval as Record<string, unknown> | null | undefined
  const approval = a && typeof a.event_id === 'string' && a.event_id.startsWith('$') && typeof a.tool === 'string'
    ? {
        eventId: a.event_id,
        tool: a.tool,
        agent: typeof a.agent === 'string' && a.agent ? a.agent : undefined,
        since: typeof a.since === 'number' ? a.since : 0,
      }
    : null
  const issues = Array.isArray(c.issues)
    ? [...new Set(c.issues.filter((k): k is string => typeof k === 'string' && ISSUE.test(k)))]
    : []
  const plan = c.plan as Record<string, unknown> | null | undefined
  const planEventId = plan && typeof plan.event_id === 'string' && plan.event_id.startsWith('$') ? plan.event_id : null
  return { approval, issues, activity: 'activity' in c ? parseActivity(c.activity) : undefined, planEventId, at }
}

/** An agent's plan, as construct-plan sets it (scripts/room-plan.mjs). */
export const PLAN_EVENT = 'com.construct.plan'

export interface PlanStep {
  text: string
  state: 'todo' | 'now' | 'done'
}

export function parsePlanSteps(content: unknown): PlanStep[] {
  const steps = (content as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps)) return []
  return steps
    .filter((s): s is { text: string; state?: unknown } => !!s && typeof s.text === 'string' && !!s.text.trim())
    .slice(0, 10)
    .map((s) => ({ text: s.text.trim(), state: s.state === 'now' || s.state === 'done' ? s.state : 'todo' }))
}

const PHASES = new Set(['thinking', 'tool', 'background'])

function parseActivity(value: unknown): RoomActivity | null {
  const a = value as Record<string, unknown> | null | undefined
  if (!a || typeof a.phase !== 'string' || !PHASES.has(a.phase)) return null
  const since = typeof a.since === 'number' ? a.since : 0
  return {
    phase: a.phase as RoomActivity['phase'],
    tool: a.phase === 'tool' && typeof a.tool === 'string' && a.tool ? a.tool : undefined,
    since,
    turnSince: typeof a.turn_since === 'number' ? a.turn_since : since,
  }
}

// The teams actually used, as in roomMedia.ts: a generic [A-Z]+-\d+ also
// matches UTF-8, SHA-256, ISO-8601.
const NAME_KEY = /\b(BEN-\d{1,5})\b/g

/** The issue ids a room name starts with or mentions ("BEN-359 + BEN-364 Captures"). */
export function issuesInName(name: string | undefined): string[] {
  if (!name) return []
  return [...new Set([...name.matchAll(NAME_KEY)].map((m) => m[1]))]
}
