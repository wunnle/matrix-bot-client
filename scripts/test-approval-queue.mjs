// Exercises the approval queue.
//
//   node scripts/test-approval-queue.mjs
//
// Drives the real createApprovalQueue with a `present` that records instead of
// posting to Matrix, so this covers the code the bot runs rather than a copy of
// it. What is under test is which question is on screen, which caller gets
// which answer, and that nothing is left waiting on a card that never appears.
import assert from 'node:assert'
import { createApprovalQueue } from './approval-queue.mjs'

const TIMEOUT_MS = 200
const MAX = 5

let posted = []
let timedOut = []
const q = createApprovalQueue({
  timeoutMs: TIMEOUT_MS,
  maxQueued: MAX,
  onTimeout: (roomId, toolName) => timedOut.push(`${roomId}:${toolName}`),
  present: (roomId, request) => posted.push(`${roomId}:${request.toolName}`),
})

const R = '!r:local'
let failed = 0
const check = async (name, fn) => {
  posted = []
  timedOut = []
  try {
    await fn()
    console.log(`ok    ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}

await check('a second approval waits instead of being denied', async () => {
  const a = q.ask(R, { toolName: 'A' })
  const b = q.ask(R, { toolName: 'B' })
  assert.deepEqual(posted, [`${R}:A`], 'only the first is on screen')
  q.settle(R, 'allow', 'yes')
  assert.equal((await a).decision, 'allow')
  assert.deepEqual(posted, [`${R}:A`, `${R}:B`], 'B goes up once A settles')
  q.settle(R, 'deny', 'no')
  assert.equal((await b).decision, 'deny')
})

await check('answers land on the card that is showing, in order', async () => {
  const a = q.ask(R, { toolName: 'A' })
  const b = q.ask(R, { toolName: 'B' })
  q.settle(R, 'deny', 'first')
  q.settle(R, 'allow', 'second')
  assert.equal((await a).reason, 'first')
  assert.equal((await b).reason, 'second')
})

await check('a caller that goes away is dropped from the queue', async () => {
  const a = q.ask(R, { toolName: 'A' })
  const gone = new AbortController()
  const b = q.ask(R, { toolName: 'B', signal: gone.signal })
  const c = q.ask(R, { toolName: 'C' })
  gone.abort()
  assert.equal((await b).decision, 'deny', 'B resolves without ever being shown')
  assert.deepEqual(posted, [`${R}:A`], 'aborting a queued entry posts nothing')
  q.settle(R, 'allow', 'yes')
  await a
  assert.deepEqual(posted, [`${R}:A`, `${R}:C`], 'C follows A, skipping the abandoned B')
  q.settle(R, 'allow', 'yes')
  await c
})

await check('aborting the showing card advances to the next', async () => {
  const gone = new AbortController()
  const a = q.ask(R, { toolName: 'A', signal: gone.signal })
  const b = q.ask(R, { toolName: 'B' })
  gone.abort()
  assert.equal((await a).decision, 'deny')
  assert.deepEqual(posted, [`${R}:A`, `${R}:B`])
  q.settle(R, 'allow', 'yes')
  await b
})

await check('a timeout denies only its own card and shows the next', async () => {
  const a = q.ask(R, { toolName: 'A' })
  const b = q.ask(R, { toolName: 'B' })
  assert.equal((await a).reason, 'Timed out waiting for approval.')
  assert.deepEqual(timedOut, [`${R}:A`], 'the room is told which one expired')
  assert.deepEqual(posted, [`${R}:A`, `${R}:B`])
  q.settle(R, 'allow', 'yes')
  assert.equal((await b).decision, 'allow')
})

await check('a runaway backlog is refused rather than queued forever', async () => {
  const first = q.ask(R, { toolName: 'A' })
  const queued = Array.from({ length: MAX }, (_, i) => q.ask(R, { toolName: `Q${i}` }))
  const overflow = await q.ask(R, { toolName: 'TOOMANY' })
  assert.equal(overflow.decision, 'deny')
  assert.match(overflow.reason, /already waiting/)
  q.dropQueued(R, 'cleanup')
  q.settle(R, 'deny', 'cleanup')
  await Promise.all([first, ...queued])
})

await check('stopping a turn drops what was queued behind it', async () => {
  const a = q.ask(R, { toolName: 'A' })
  const b = q.ask(R, { toolName: 'B' })
  assert.equal(q.dropQueued(R, 'Stopped from chat.'), 1)
  q.settle(R, 'deny', 'Stopped from chat.')
  assert.equal((await b).reason, 'Stopped from chat.')
  assert.deepEqual(posted, [`${R}:A`], 'nothing new goes up after a stop')
  await a
})

await check('rooms do not interfere with each other', async () => {
  const a = q.ask('!one:local', { toolName: 'A' })
  const b = q.ask('!two:local', { toolName: 'B' })
  assert.deepEqual(posted, ['!one:local:A', '!two:local:B'], 'a busy room does not queue another room')
  q.settle('!one:local', 'allow', 'yes')
  q.settle('!two:local', 'allow', 'yes')
  await Promise.all([a, b])
})

await check('settle reports whether there was anything to settle', async () => {
  assert.equal(q.settle(R, 'allow', 'nothing'), false, 'an empty room settles nothing')
  const a = q.ask(R, { toolName: 'A' })
  assert.equal(q.settle(R, 'allow', 'yes'), true)
  await a
})

await check('calls queued behind a card are auto-answered once auto mode is on', async () => {
  // Auto mode flips on mid-queue (Approve + auto); B is one it would answer,
  // C one it would leave to a human.
  let auto = false
  const shown = []
  const aq = createApprovalQueue({
    timeoutMs: TIMEOUT_MS,
    present: (roomId, request) => shown.push(request.toolName),
    autoAnswer: (roomId, request) =>
      auto && request.toolName !== 'C' ? { decision: 'allow', reason: 'auto' } : null,
  })
  const a = aq.ask(R, { toolName: 'A' })
  const b = aq.ask(R, { toolName: 'B' })
  const c = aq.ask(R, { toolName: 'C' })
  const d = aq.ask(R, { toolName: 'D' })
  auto = true
  aq.settle(R, 'allow', 'yes')
  assert.equal((await a).reason, 'yes')
  assert.equal((await b).reason, 'auto', 'B never reaches the screen')
  assert.deepEqual(shown, ['A', 'C'], 'C still asks, and it is next up')
  aq.settle(R, 'deny', 'no')
  assert.equal((await c).decision, 'deny')
  assert.equal((await d).reason, 'auto', 'the queue keeps draining past a human answer')
  assert.deepEqual(shown, ['A', 'C'])
  assert.equal(aq.settle(R, 'allow', 'x'), false, 'nothing is left on screen')
})

console.log(failed ? `\n${failed} failed` : '\n10/10 approval queue assertions passed')
process.exit(failed ? 1 : 0)
