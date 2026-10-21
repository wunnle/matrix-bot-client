import assert from 'node:assert/strict'
import { createCardPoster, subagentBody, subagentContent } from './subagent-cards.mjs'

const card = (status, n = 0) => ({ id: 'A', description: 'Survey', agentType: 'Explore', status, lines: Array(n).fill({ emoji: '💻', tool: 'terminal', content: 'x' }) })

assert.equal(subagentBody(card('running')), '🤖 agent: Survey (Explore) — working')
assert.equal(subagentBody({ ...card('completed'), agentType: undefined }), '🤖 agent: Survey — done')
assert.ok(subagentContent(card('running'))['com.construct.machine'], 'cards never push')

const tick = () => new Promise((r) => setTimeout(r, 0))

{
  // First snapshot posts, later ones edit, and a burst collapses into one edit.
  const sent = []
  let clock = 0
  const poster = createCardPoster({
    send: async (c) => { sent.push(['send', c['com.construct.subagent'].lines.length]); return '$e1' },
    edit: async (id, c) => { sent.push(['edit', id, c['com.construct.subagent'].lines.length]) },
    throttleMs: 40, now: () => clock,
  })
  poster.update(card('running', 0))
  clock = 10; poster.update(card('running', 1))
  clock = 20; poster.update(card('running', 2))
  await tick()
  assert.deepEqual(sent, [['send', 0]], 'held back inside the throttle window')
  clock = 50
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(sent, [['send', 0], ['edit', '$e1', 2]], 'only the newest of the burst is sent')
  // A finished card goes at once, whatever the window says.
  clock = 55; await poster.update(card('completed', 3))
  assert.deepEqual(sent.at(-1), ['edit', '$e1', 3])
}

{
  // An edit never overtakes the send that creates its event.
  const sent = []
  let release
  const poster = createCardPoster({
    send: () => new Promise((r) => { release = () => { sent.push('send'); r('$e2') } }),
    edit: async (id) => { sent.push(`edit:${id}`) },
    throttleMs: 0,
  })
  poster.update(card('running'))
  const done = poster.update(card('completed'))
  await tick()
  assert.deepEqual(sent, [])
  release()
  await done
  assert.deepEqual(sent, ['send', 'edit:$e2'])
}

{
  // A card whose first send failed stops trying; errors are reported, not thrown.
  const errors = []
  let edits = 0
  const poster = createCardPoster({
    send: async () => { throw new Error('403') },
    edit: async () => { edits++ },
    throttleMs: 0, onError: (e) => errors.push(e.message),
  })
  await poster.update(card('running'))
  await poster.update(card('completed'))
  assert.deepEqual(errors, ['403'])
  assert.equal(edits, 0)
}

{
  // drain sends what a throttle timer still holds.
  const sent = []
  let clock = 0
  const poster = createCardPoster({
    send: async () => { sent.push('send'); return '$e3' },
    edit: async (_, c) => { sent.push(`edit:${c['com.construct.subagent'].lines.length}`) },
    throttleMs: 10000, now: () => clock,
  })
  poster.update(card('running', 0))
  clock = 1; poster.update(card('running', 4))
  await poster.drain()
  assert.deepEqual(sent, ['send', 'edit:4'])
}

console.log('subagent cards: ok')
