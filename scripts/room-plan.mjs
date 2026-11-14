// An agent room's plan: a few steps the agent sets once it has understood the
// request (construct-plan) and ticks off as it goes. Construct shows it in the
// room's side panel.
//
// Each version is its own `com.construct.plan` event, encrypted like any other
// in an encrypted room, and the room status (room-status.mjs) points at the
// newest. A custom event type rather than a message, so no timeline (Construct's
// or Element's), unread count or notification ever treats it as one.
//
//   { "steps": [{ "text": "Read the hook code", "state": "done" },
//               { "text": "Publish the phase", "state": "now" },
//               { "text": "Ship", "state": "todo" }] }
export const PLAN_EVENT = 'com.construct.plan'

export const MAX_STEPS = 10
export const MAX_TEXT = 140
const STATES = new Set(['todo', 'now', 'done'])

/** Steps from event content or storage, dropping anything malformed. */
export function parsePlan(value) {
  const list = Array.isArray(value) ? value : value?.steps
  if (!Array.isArray(list)) return []
  return list
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .slice(0, MAX_STEPS)
    .map((s) => ({ text: s.text.trim().slice(0, MAX_TEXT), state: STATES.has(s.state) ? s.state : 'todo' }))
}

/**
 * The plan after one change, or `{ error }`:
 *   { set: [text…] }   a new plan, its first step under way
 *   { add: [text…] }   more steps at the end
 *   { done: [n…] }     steps finished (1-based); the next open one starts
 *   { now: n }         step n is the one under way
 *   { clear: true }    no plan
 */
export function applyPlanOp(current, op) {
  let steps = parsePlan(current)
  const texts = (list) => (Array.isArray(list) ? list : []).map((t) => String(t).trim()).filter(Boolean)
  const indexes = (list) => {
    const ns = (Array.isArray(list) ? list : [list]).map(Number)
    const bad = ns.filter((n) => !Number.isInteger(n) || n < 1 || n > steps.length)
    return bad.length ? { error: `no step ${bad.join(', ')}: the plan has ${steps.length}` } : { ns }
  }

  if (op?.clear) return { steps: [] }
  if (op?.set) {
    const t = texts(op.set)
    if (!t.length) return { error: 'a plan needs at least one step' }
    if (t.length > MAX_STEPS) return { error: `at most ${MAX_STEPS} steps` }
    steps = t.map((text, i) => ({ text: text.slice(0, MAX_TEXT), state: i === 0 ? 'now' : 'todo' }))
    return { steps }
  }
  if (op?.add) {
    const t = texts(op.add)
    if (!t.length) return { error: 'nothing to add' }
    if (steps.length + t.length > MAX_STEPS) return { error: `at most ${MAX_STEPS} steps` }
    steps = [...steps, ...t.map((text) => ({ text: text.slice(0, MAX_TEXT), state: 'todo' }))]
    if (!steps.some((s) => s.state === 'now')) startNext(steps)
    return { steps }
  }
  if (op?.done !== undefined) {
    if (!steps.length) return { error: 'there is no plan yet' }
    const { ns, error } = indexes(op.done)
    if (error) return { error }
    steps = steps.map((s, i) => (ns.includes(i + 1) ? { ...s, state: 'done' } : s))
    if (!steps.some((s) => s.state === 'now')) startNext(steps)
    return { steps }
  }
  if (op?.now !== undefined) {
    if (!steps.length) return { error: 'there is no plan yet' }
    const { ns, error } = indexes(op.now)
    if (error) return { error }
    const n = ns[0]
    steps = steps.map((s, i) => (i + 1 === n ? { ...s, state: 'now' } : s.state === 'now' ? { ...s, state: 'todo' } : s))
    return { steps }
  }
  return { error: 'unknown change' }
}

// The first step not yet done is the one under way.
function startNext(steps) {
  const next = steps.findIndex((s) => s.state === 'todo')
  if (next >= 0) steps[next] = { ...steps[next], state: 'now' }
}

/** One line per step, as the CLI prints it back. */
export function formatPlan(steps) {
  if (!steps.length) return '(no plan)'
  const mark = { done: '[x]', now: '[>]', todo: '[ ]' }
  return steps.map((s, i) => `${mark[s.state]} ${i + 1}. ${s.text}`).join('\n')
}
