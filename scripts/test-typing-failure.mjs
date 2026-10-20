import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('./claude-code-bot.mjs', import.meta.url), 'utf8')
const drain = source.slice(source.indexOf('async function drainRoom('), source.indexOf('\nclient.on(sdk.RoomEvent.Timeline'))
for (const status of [429, 503]) {
  test(`typing HTTP ${status} must not prevent the turn or busy cleanup`, async () => {
    const busy = new Set(), queued = new Map(), turns = [], replies = []
    let cleared = false
    const context = vm.createContext({
      busy, queued, stopped: new Set(), sessions: {},
      client: {
        sendTyping: async () => { throw Object.assign(new Error('Server unavailable'), { httpStatus: status }) },
        sendReadReceipt: async () => {},
      },
      setInterval: () => 1, clearInterval: () => { cleared = true },
      promptFor: async (_event, text) => text,
      runTurn: async (_room, prompt) => { turns.push(prompt); return { text: 'pong' } },
      refreshUsage: () => {}, detectLimitBlock: () => null, setBlocked: async () => {},
      sendRoomText: async (_room, text) => { replies.push(text) },
    })
    vm.runInContext(drain, context)
    await context.drainRoom('room', { getContent: () => ({ body: 'ping' }) })
    assert.deepEqual(turns, ['ping'])
    assert.deepEqual(replies, ['pong'])
    assert.equal(busy.size, 0)
    assert.equal(cleared, true)
  })
}
