import assert from 'node:assert/strict'
import { matchTier, rankCommands } from '../src/lib/commandSearch.js'

const rooms = [
  { title: 'BEN-359 Scruffy captures', recency: 100 },
  { title: 'BEN-364 Captures cleanup', recency: 300 },
  { title: 'Bender', recency: 50 },
  { title: 'Hermes', recency: 400 },
  { title: 'New Claude room', keywords: ['spawn', 'agent'] },
]
const titles = (q) => rankCommands(rooms, q).map((r) => r.title)

// Linear id prefix.
assert.deepEqual(titles('ben-359'), ['BEN-359 Scruffy captures'])
assert.equal(titles('BEN-3')[0], 'BEN-364 Captures cleanup', 'recency breaks a tie between two prefix matches')
// Title prefix beats word prefix, whatever the recency.
assert.deepEqual(titles('ben').slice(0, 3), ['BEN-364 Captures cleanup', 'BEN-359 Scruffy captures', 'Bender'])
// Word prefix beats a plain substring.
assert.equal(matchTier('capt', 'BEN-359 Scruffy captures'), 3)
assert.equal(matchTier('aptur', 'BEN-359 Scruffy captures'), 2)
// Keywords count as substrings, not prefixes of the title.
assert.deepEqual(titles('spawn'), ['New Claude room'])
// Every word of the query, in any order.
assert.deepEqual(titles('captures scruffy'), ['BEN-359 Scruffy captures'])
// Loose subsequence only when nothing matches as a substring…
assert.deepEqual(titles('hrms'), ['Hermes'])
// …and dropped as soon as something does: "her" is a prefix of Hermes, and a
// loose match in "BEN-364 … cleanup"/"Scruffy captures" must not tag along.
assert.deepEqual(titles('her'), ['Hermes'])
assert.equal(matchTier('xyz', 'Hermes'), 0)
// Empty query: everything, newest first.
assert.deepEqual(titles('').slice(0, 2), ['Hermes', 'BEN-364 Captures cleanup'])
// Accents and case.
assert.equal(matchTier('cafe', 'Café plans'), 4)

console.log('command search: prefix > word > substring > loose, recency tiebreak OK')
