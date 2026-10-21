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
    throttleMs: 40, quickMs: 0, now: () => clock,
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
    throttleMs: 0, quickMs: 0,
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
    throttleMs: 0, quickMs: 0, onError: (e) => errors.push(e.message),
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
    throttleMs: 10000, quickMs: 0, now: () => clock,
  })
  poster.update(card('running', 0))
  clock = 1; poster.update(card('running', 4))
  await poster.drain()
  assert.deepEqual(sent, ['send', 'edit:4'])
}

// Quick subagents: held back, and folded into one line if they finish in time.
const recorder = (extra = {}) => {
  const log = []
  const poster = createCardPoster({
    send: async (c) => { log.push(`send:${c['com.construct.subagent'].status}`); return '$q' },
    edit: async (_, c) => { log.push(`edit:${c['com.construct.subagent'].status}`) },
    onQuick: (c) => log.push(`line:${c.description}`),
    throttleMs: 0, quickMs: 40, ...extra,
  })
  return { log, poster }
}

{
  // Done inside the window: a line, never a card, and later snapshots are ignored.
  const { log, poster } = recorder()
  poster.update(card('running', 0))
  poster.update(card('running', 2))
  poster.update(card('completed', 2))
  poster.update(card('completed', 3))
  await new Promise((r) => setTimeout(r, 60))
  await poster.drain()
  assert.deepEqual(log, ['line:Survey'])
}

{
  // Still running when the window closes: the card appears, with the latest snapshot.
  const { log, poster } = recorder()
  poster.update(card('running', 0))
  poster.update(card('running', 5))
  await tick()
  assert.deepEqual(log, [], 'nothing while held')
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(log, ['send:running'])
  await poster.update(card('completed', 6))
  assert.deepEqual(log, ['send:running', 'edit:completed'], 'once a card, always a card')
}

{
  // A quick failure or stop is worth seeing, so it is a card straight away.
  for (const status of ['failed', 'stopped']) {
    const { log, poster } = recorder()
    poster.update(card('running'))
    await poster.update(card(status))
    assert.deepEqual(log, [`send:${status}`])
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(log, [`send:${status}`], 'the held timer does not send it twice')
  }
}

{
  // The turn ending while one is held: still running becomes a card.
  const { log, poster } = recorder({ quickMs: 10000 })
  poster.update(card('running', 1))
  await poster.drain()
  assert.deepEqual(log, ['send:running'])
}

{
  // A throwing onQuick is reported, not thrown.
  const errors = []
  const poster = createCardPoster({
    send: async () => '$x', edit: async () => {},
    onQuick: () => { throw new Error('nope') }, onError: (e) => errors.push(e.message),
  })
  poster.update(card('running'))
  await poster.update(card('completed'))
  assert.deepEqual(errors, ['nope'])
}

console.log('subagent cards: ok')
