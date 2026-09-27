import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  AppServer,
  progressForItem,
  questionsForRoom,
  answersForCodex,
  unsupportedResponse,
} from './providers/codex.mjs'

const progressCases = [
  [{ id: 'c1', type: 'commandExecution', command: '/bin/bash -lc "TOKEN=secret npm test"', cwd: '/repo' },
    { id: 'c1', emoji: '💻', tool: 'terminal', content: 'Running a command' }],
  [{ id: 'f1', type: 'fileChange', changes: [{ path: '/repo/.env', kind: { type: 'update' } }] },
    { id: 'f1', emoji: '✏️', tool: 'edit', content: 'Editing 1 file' }],
  [{ id: 'w1', type: 'webSearch', query: 'private acquisition target' },
    { id: 'w1', emoji: '🌐', tool: 'websearch', content: 'Searching the web' }],
  [{ id: 'm1', type: 'mcpToolCall', server: 'private', tool: 'lookup', arguments: { token: 'secret' } },
    { id: 'm1', emoji: '🔧', tool: 'lookup', content: 'Using private' }],
  [{ id: 'a1', type: 'agentMessage', text: 'hello' }, null],
]
for (const [item, expected] of progressCases) {
  assert.deepEqual(progressForItem(item, '/repo'), expected)
}

const protocolQuestions = [
  { id: 'choice', header: 'Deploy', question: 'Where?', isOther: true, isSecret: false,
    options: [{ label: 'Staging', description: 'Safe' }, { label: 'Production', description: 'Live' }] },
  { id: 'note', header: 'Note', question: 'Anything else?', isOther: true, isSecret: false, options: null },
]
assert.deepEqual(questionsForRoom(protocolQuestions), [
  { id: 'choice', title: 'Deploy', prompt: 'Where?', options: ['Staging', 'Production'], allowOther: true },
  { id: 'note', title: 'Note', prompt: 'Anything else?', options: [], allowOther: true },
])
assert.deepEqual(answersForCodex(protocolQuestions, { choice: 'Production', note: 'Ship it' }), {
  answers: {
    choice: { answers: ['Production'] },
    note: { answers: ['Ship it'] },
  },
})
assert.deepEqual(unsupportedResponse('mcpServer/elicitation/request'), { result: { action: 'decline' } })
assert.deepEqual(unsupportedResponse('item/permissions/requestApproval'), {
  error: { code: -32601, message: 'Permission-profile escalation is not supported by this client' },
})
assert.throws(
  () => questionsForRoom([{ id: 'secret', header: 'Token', question: 'Token?', isSecret: true, options: null }]),
  /secret/i,
)

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = {
    write(line) {
      const request = JSON.parse(line)
      if (!request.id) return true
      let result = {}
      if (request.method === 'model/list') result = { data: [{ id: 'gpt-5.6-sol' }] }
      if (request.method === 'mcpServerStatus/list') result = { data: [] }
      queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'))
      return true
    },
  }
  child.kill = () => child.emit('exit', null, 'SIGTERM')
  return child
}

const children = []
const appServer = new AppServer(() => {
  const child = fakeChild()
  children.push(child)
  return child
})
await appServer.connect()
children[0].emit('exit', 1, null)
await appServer.connect()
children[0].stdout.write('{stale garbage\n')
children[0].emit('exit', 1, null) // delayed duplicate from the dead process
assert.deepEqual(await appServer.request('model/list', {}), { data: [{ id: 'gpt-5.6-sol' }] })
assert.equal(children.length, 2)
children[1].emit('exit', 0, null)

console.log('codex provider helpers passed')
