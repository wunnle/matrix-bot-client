// Exercises the pure part of the home-screen boards (api/_widgets.js).
//
//   node scripts/test-widgets.mjs
//
// The board shape is a contract with `Board` in the widget, so that's what's
// pinned, plus merge and validation. Nothing here touches the network.
import assert from 'node:assert'
import { buildBoard, MAX_BOARD_TILES, MAX_LINES } from '../api/_widgets.js'
import { ActivityError } from '../api/_activities.js'

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
const rejects = (fn, pattern) => {
  assert.throws(fn, (e) => e instanceof ActivityError && e.status === 400 && pattern.test(e.message))
}

const NOW = 1_800_000_000_000

check('a new board has every key the widget reads', () => {
  const b = buildBoard({ title: 'Work', tiles: [{ icon: 'linear', value: '3', sub: 'in progress' }] }, null, NOW)
  assert.deepStrictEqual(b, {
    title: 'Work', tone: 'neutral',
    tiles: [{ icon: 'linear', value: '3', sub: 'in progress' }],
    lines: [], roomId: '', updatedAt: NOW / 1000,
  })
})

check('set only changes what it is given', () => {
  const prev = buildBoard({ title: 'Work', lines: ['a', 'b'], room: '!r:x' }, null, NOW)
  const b = buildBoard({ tiles: [{ icon: 'discord', value: '2', tone: 'warning' }] }, prev, NOW + 1000)
  assert.strictEqual(b.title, 'Work')
  assert.deepStrictEqual(b.lines, ['a', 'b'])
  assert.strictEqual(b.roomId, '!r:x')
  assert.deepStrictEqual(b.tiles, [{ icon: 'discord', value: '2', tone: 'warning' }])
  assert.strictEqual(b.updatedAt, NOW / 1000 + 1)
})

check('null clears tiles, lines and room', () => {
  const prev = buildBoard({ title: 'W', tiles: [{ icon: 'x', value: '1' }], lines: ['a'], room: '!r:x' }, null, NOW)
  const b = buildBoard({ tiles: null, lines: null, room: null }, prev, NOW)
  assert.deepStrictEqual([b.tiles, b.lines, b.roomId], [[], [], ''])
})

check('limits', () => {
  const tile = { icon: 'x', value: '1' }
  buildBoard({ tiles: Array(MAX_BOARD_TILES).fill(tile) }, null, NOW)
  rejects(() => buildBoard({ tiles: Array(MAX_BOARD_TILES + 1).fill(tile) }, null, NOW), /at most 4 tiles/)
  rejects(() => buildBoard({ lines: Array(MAX_LINES + 1).fill('a') }, null, NOW), /at most 3 lines/)
  rejects(() => buildBoard({ title: 'W', tone: 'pink' }, null, NOW), /tone must be/)
  rejects(() => buildBoard({ title: 'W', room: 'general' }, null, NOW), /room id/)
  rejects(() => buildBoard({}, null, NOW), /needs a title/)
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
