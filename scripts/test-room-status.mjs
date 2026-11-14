// Exercises the room status content (scripts/room-status.mjs).
//
//   node scripts/test-room-status.mjs
import assert from 'node:assert'
import { parseRoomStatus, patchRoomStatus, normalizeIssues } from './room-status.mjs'

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

const NOTHING = { approval: null, issues: [], activity: null, plan: null }

check('empty or malformed content reads as nothing pending, no issues, no turn', () => {
  assert.deepStrictEqual(parseRoomStatus(undefined), NOTHING)
  assert.deepStrictEqual(parseRoomStatus({ approval: { tool: 'Bash' }, issues: 'BEN-1', activity: { phase: 'dancing' } }), NOTHING)
  assert.deepStrictEqual(parseRoomStatus({ approval: { event_id: 'nope', tool: 'Bash' } }).approval, null)
})

check('an approval keeps its pointer, tool, agent and time', () => {
  const s = parseRoomStatus({ approval: { event_id: '$a', tool: 'Edit', agent: 'Explore', since: 5, body: 'rm -rf' } })
  assert.deepStrictEqual(s.approval, { event_id: '$a', tool: 'Edit', agent: 'Explore', since: 5 })
})

check('issues are upper-cased, deduplicated and capped', () => {
  assert.deepStrictEqual(normalizeIssues(['ben-1', 'BEN-1', 'utf8', 'BEN-2', 'X', 'BEN-3', 'BEN-4', 'BEN-5', 'BEN-6']), ['BEN-1', 'BEN-2', 'BEN-3', 'BEN-4', 'BEN-5'])
})

check('activity keeps its phase, tool and times, and nothing else', () => {
  const a = parseRoomStatus({ activity: { phase: 'tool', tool: 'terminal', since: 9, turn_since: 3, command: 'rm -rf ~' } }).activity
  assert.deepStrictEqual(a, { phase: 'tool', tool: 'terminal', since: 9, turn_since: 3 })
  // A tool name only means something while a tool runs; a turn start defaults to the phase's.
  assert.deepStrictEqual(parseRoomStatus({ activity: { phase: 'thinking', tool: 'x', since: 4 } }).activity, { phase: 'thinking', since: 4, turn_since: 4 })
})

check('a patch touches only the keys it names', () => {
  const base = { approval: { event_id: '$a', tool: 'Bash', since: 1 }, issues: ['BEN-1'] }
  assert.deepStrictEqual(patchRoomStatus(base, { issues: ['BEN-2'] }), { approval: base.approval, issues: ['BEN-2'], activity: null, plan: null })
  assert.deepStrictEqual(patchRoomStatus(base, { approval: null }), { approval: null, issues: ['BEN-1'], activity: null, plan: null })
  const busy = patchRoomStatus(base, { activity: { phase: 'thinking', since: 2, turn_since: 2 } })
  assert.deepStrictEqual(busy.activity, { phase: 'thinking', since: 2, turn_since: 2 })
  assert.deepStrictEqual(busy.issues, ['BEN-1'])
})

check('an unchanged patch is null, so nothing is re-sent', () => {
  assert.strictEqual(patchRoomStatus({ issues: ['BEN-1'] }, { issues: ['ben-1'] }), null)
  assert.strictEqual(patchRoomStatus({}, { approval: null }), null)
  assert.strictEqual(patchRoomStatus({}, { activity: null }), null)
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
