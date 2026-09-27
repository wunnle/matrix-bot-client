import assert from 'node:assert/strict'
import { createQuestionQueue } from './question-queue.mjs'

const shown = []
const q = createQuestionQueue({
  timeoutMs: 1000,
  present: (roomId, question) => shown.push([roomId, question.id]),
})

const first = q.ask('room', { id: 'one', prompt: 'First?', options: ['A', 'B'], allowOther: false })
const second = q.ask('room', { id: 'two', prompt: 'Second?', options: [], allowOther: true })
assert.deepEqual(shown, [['room', 'one']])
assert.equal(q.answer('room', 'nope'), false)
assert.equal(q.answer('room', 'b'), true)
assert.equal(await first, 'B')
assert.deepEqual(shown, [['room', 'one'], ['room', 'two']])
assert.equal(q.answer('room', 'free form'), true)
assert.equal(await second, 'free form')

const dropped = q.ask('room', { id: 'three', prompt: 'Third?', options: [], allowOther: true })
assert.equal(q.drop('room', 'stopped'), true)
await assert.rejects(dropped, /stopped/)
assert.equal(q.answer('room', 'late'), false)

console.log('question queue passed')
