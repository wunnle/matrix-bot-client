import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createStore } from './watchlist/store.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-'))
let clock = 1000
const store = createStore(dir, { now: () => clock++ })

const a = store.add({ id: 'tt0903747', kind: 'series', title: 'Breaking Bad', year: 2008 })
assert.equal(a.added, true)
assert.equal(a.item.watchedAt, null)
assert.equal(store.add({ id: 'tt0903747', kind: 'series', title: 'Breaking Bad' }).added, false)
assert.throws(() => store.add({ id: 'Breaking Bad', kind: 'series', title: 'x' }), /IMDb id/)

store.add({ id: 'tt11280740', kind: 'series', title: 'Severance', year: 2022 })
// Newest first.
assert.deepEqual(store.list().map((i) => i.id), ['tt11280740', 'tt0903747'])

assert.ok(store.setWatched('tt0903747', true).watchedAt)
// Marking twice is a no-op, not a second history line.
store.setWatched('tt0903747', true)
assert.equal(store.setWatched('tt0903747', false).watchedAt, null)
assert.throws(() => store.setWatched('tt0000001', true), /not on the watchlist/)

// A refresh changes details but never the list's own fields, and logs nothing.
const before = store.get('tt11280740')
const refreshed = store.update('tt11280740', { providers: ['apple'], next: null, addedAt: 0, watchedAt: 5, id: 'tt1' })
assert.deepEqual(refreshed.providers, ['apple'])
assert.equal(refreshed.addedAt, before.addedAt)
assert.equal(refreshed.watchedAt, null)
assert.equal(refreshed.id, 'tt11280740')
// Extra details given at add time are kept.
assert.deepEqual(store.add({ id: 'tt0000002', kind: 'movie', title: 'X', providers: ['netflix'] }).item.providers, ['netflix'])
store.remove('tt0000002')

store.played('tt11280740', { via: 'stremio' })
store.remove('tt11280740')
assert.throws(() => store.remove('tt11280740'), /not on the watchlist/)

// The list survives a reload, and a returned item is a copy, not a handle.
const reloaded = createStore(dir)
assert.deepEqual(reloaded.list().map((i) => i.id), ['tt0903747'])
reloaded.get('tt0903747').title = 'mutated'
assert.equal(reloaded.get('tt0903747').title, 'Breaking Bad')

assert.deepEqual(store.history().map((h) => `${h.action} ${h.id}`), [
  'added tt0903747',
  'added tt11280740',
  'watched tt0903747',
  'unwatched tt0903747',
  'added tt0000002',
  'removed tt0000002',
  'played tt11280740',
  'removed tt11280740',
])
assert.equal(store.history()[6].via, 'stremio')

fs.rmSync(dir, { recursive: true })
console.log('watchlist store passed')
