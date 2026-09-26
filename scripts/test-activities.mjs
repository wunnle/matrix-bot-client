// Exercises the pure parts of the Live Activity channel (api/_activities.js).
//
//   node scripts/test-activities.mjs
//
// The content-state shape is a contract with ConstructActivityAttributes in the
// app; ActivityKit drops a push that doesn't decode without a word, so the
// shape is what's worth pinning. Also covers validation, expiry and eviction.
// Nothing here touches the network.
import assert from 'node:assert'
import {
  buildContentState, parseAlert, parseTtl, expiredIds, evictionIds,
  ActivityError, ID_PATTERN, DEFAULT_TTL_S, MAX_TTL_S, MAX_LIVE,
} from '../api/_activities.js'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}\n     ${e.message}`)
  }
}
const rejects = (fn, status, pattern) => {
  assert.throws(fn, (e) => e instanceof ActivityError && e.status === status && pattern.test(e.message))
}

const ctx = { roomId: '!r:local', roomName: 'Room', endsAtMs: 1_800_000_000_000 }

check('start builds the full contract shape', () => {
  const c = buildContentState({ title: 'Deploy', body: 'Tests pass', tone: 'success', actions: [{ label: 'Ship', send: 'ship it' }] }, null, ctx)
  assert.deepStrictEqual(c, {
    title: 'Deploy', body: 'Tests pass', tone: 'success',
    actions: [{ label: 'Ship', send: 'ship it' }],
    roomId: '!r:local', roomName: 'Room', endsAt: 1_800_000_000,
  })
})

check('start requires a title', () => {
  rejects(() => buildContentState({ body: 'x' }, null, ctx), 400, /title/)
})

check('defaults: neutral tone, empty body, no actions', () => {
  const c = buildContentState({ title: 'T' }, null, ctx)
  assert.strictEqual(c.tone, 'neutral')
  assert.strictEqual(c.body, '')
  assert.deepStrictEqual(c.actions, [])
  assert.ok(!('progress' in c) && !('step' in c))
})

check('an action without send sends its label; bare strings allowed', () => {
  const c = buildContentState({ title: 'T', actions: ['Yes', { label: 'No' }] }, null, ctx)
  assert.deepStrictEqual(c.actions, [{ label: 'Yes', send: 'Yes' }, { label: 'No', send: 'No' }])
})

check('more than 3 actions is refused', () => {
  rejects(() => buildContentState({ title: 'T', actions: ['a', 'b', 'c', 'd'] }, null, ctx), 400, /at most 3/)
})

check('update merges over the previous state', () => {
  const prev = buildContentState({ title: 'Deploy', body: 'Building', progress: 0.2, actions: ['Stop'] }, null, ctx)
  const next = buildContentState({ body: 'Testing', progress: 0.6 }, prev, ctx)
  assert.strictEqual(next.title, 'Deploy')
  assert.strictEqual(next.body, 'Testing')
  assert.strictEqual(next.progress, 0.6)
  assert.deepStrictEqual(next.actions, [{ label: 'Stop', send: 'Stop' }])
})

check('null clears an optional field; omitting it keeps it', () => {
  const prev = buildContentState({ title: 'T', progress: 0.5, step: '2/4' }, null, ctx)
  const kept = buildContentState({ body: 'b' }, prev, ctx)
  assert.strictEqual(kept.step, '2/4')
  const cleared = buildContentState({ progress: null }, prev, ctx)
  assert.ok(!('progress' in cleared))
  assert.strictEqual(cleared.step, '2/4')
})

check('actions: [] removes the buttons', () => {
  const prev = buildContentState({ title: 'T', actions: ['A'] }, null, ctx)
  assert.deepStrictEqual(buildContentState({ actions: [] }, prev, ctx).actions, [])
})

check('bad tone and out-of-range progress are refused', () => {
  rejects(() => buildContentState({ title: 'T', tone: 'purple' }, null, ctx), 400, /tone/)
  rejects(() => buildContentState({ title: 'T', progress: 1.5 }, null, ctx), 400, /progress/)
  rejects(() => buildContentState({ title: 'T', progress: 'half' }, null, ctx), 400, /progress/)
})

check('long text is truncated, not refused', () => {
  const c = buildContentState({ title: 'x'.repeat(200), body: 'y'.repeat(1000) }, null, ctx)
  assert.strictEqual(c.title.length, 80)
  assert.strictEqual(c.body.length, 300)
})

check('endsAt is unix seconds (the app decodes a Double, not a Date)', () => {
  const c = buildContentState({ title: 'T' }, null, { ...ctx, endsAtMs: 1_700_000_123_999 })
  assert.strictEqual(c.endsAt, 1_700_000_123)
})

check('alert levels', () => {
  assert.strictEqual(parseAlert(undefined, 'quiet'), 'quiet')
  assert.strictEqual(parseAlert('loud', 'none'), 'loud')
  rejects(() => parseAlert('shout', 'none'), 400, /alert/)
})

check('ttl: default, capped at 8h, positive only', () => {
  assert.strictEqual(parseTtl(undefined), DEFAULT_TTL_S)
  assert.strictEqual(parseTtl(10 * 60 * 60), MAX_TTL_S)
  assert.strictEqual(parseTtl(90.7), 90)
  rejects(() => parseTtl(0), 400, /ttl/)
  rejects(() => parseTtl('soon'), 400, /ttl/)
})

check('ids: safe characters only', () => {
  assert.ok(ID_PATTERN.test('deploy-ben-286'))
  assert.ok(ID_PATTERN.test('run:2026.09.27_1'))
  assert.ok(!ID_PATTERN.test(''))
  assert.ok(!ID_PATTERN.test('has space'))
  assert.ok(!ID_PATTERN.test('x'.repeat(65)))
})

check('expiry: past endsAt, or a start that never registered a token', () => {
  const now = 1_000_000_000
  const ids = expiredIds({
    live: { token: 't', startedAt: now - 5_000, endsAt: now + 60_000 },
    expired: { token: 't', startedAt: now - 90_000, endsAt: now - 1 },
    neverRegistered: { token: null, startedAt: now - 11 * 60_000, endsAt: now + 60_000 },
    justStarted: { token: null, startedAt: now - 30_000, endsAt: now + 60_000 },
  }, now)
  assert.deepStrictEqual(ids.sort(), ['expired', 'neverRegistered'])
})

check(`eviction keeps the newest ${MAX_LIVE - 1} so a start fits under ${MAX_LIVE}`, () => {
  const acts = {
    a: { updatedAt: 1 }, b: { updatedAt: 3 }, c: { updatedAt: 2 },
  }
  assert.deepStrictEqual(evictionIds(acts), ['a'])
  assert.deepStrictEqual(evictionIds({ a: { updatedAt: 1 } }), [])
  assert.deepStrictEqual(evictionIds({ ...acts, d: { updatedAt: 0 } }), ['d', 'a'])
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
