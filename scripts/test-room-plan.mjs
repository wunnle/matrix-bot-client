// Exercises plan changes (scripts/room-plan.mjs).
//
//   node scripts/test-room-plan.mjs
import assert from 'node:assert'
import { applyPlanOp, parsePlan, formatPlan, MAX_STEPS } from './room-plan.mjs'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok    ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
const states = (r) => r.steps.map((s) => s.state).join(' ')

check('a new plan starts on its first step', () => {
  const r = applyPlanOp([], { set: ['Read', ' Change ', '', 'Ship'] })
  assert.deepStrictEqual(r.steps.map((s) => s.text), ['Read', 'Change', 'Ship'])
  assert.strictEqual(states(r), 'now todo todo')
})

check('finishing a step starts the next open one', () => {
  let r = applyPlanOp([], { set: ['a', 'b', 'c'] })
  r = applyPlanOp(r.steps, { done: [1] })
  assert.strictEqual(states(r), 'done now todo')
  r = applyPlanOp(r.steps, { done: [2, 3] })
  assert.strictEqual(states(r), 'done done done')
})

check('now moves the marker without undoing finished steps', () => {
  let r = applyPlanOp([], { set: ['a', 'b', 'c'] })
  r = applyPlanOp(r.steps, { done: 1 })
  r = applyPlanOp(r.steps, { now: 3 })
  assert.strictEqual(states(r), 'done todo now')
})

check('adding to a finished plan starts the new step', () => {
  let r = applyPlanOp([], { set: ['a'] })
  r = applyPlanOp(r.steps, { done: 1 })
  r = applyPlanOp(r.steps, { add: ['b'] })
  assert.strictEqual(states(r), 'done now')
})

check('bad changes are errors, not silent', () => {
  assert.ok(applyPlanOp([], { done: 1 }).error)
  assert.ok(applyPlanOp(applyPlanOp([], { set: ['a'] }).steps, { done: 2 }).error)
  assert.ok(applyPlanOp([], { set: [] }).error)
  assert.ok(applyPlanOp([], { set: Array.from({ length: MAX_STEPS + 1 }, (_, i) => `s${i}`) }).error)
  assert.ok(applyPlanOp([], { dance: true }).error)
})

check('clear empties it; malformed steps are dropped', () => {
  assert.deepStrictEqual(applyPlanOp([{ text: 'a', state: 'now' }], { clear: true }), { steps: [] })
  assert.deepStrictEqual(parsePlan({ steps: [{ text: 'a', state: 'weird' }, { state: 'done' }, 'x'] }), [{ text: 'a', state: 'todo' }])
})

check('the CLI print-out marks each state', () => {
  assert.strictEqual(formatPlan([{ text: 'a', state: 'done' }, { text: 'b', state: 'now' }, { text: 'c', state: 'todo' }]), '[x] 1. a\n[>] 2. b\n[ ] 3. c')
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
