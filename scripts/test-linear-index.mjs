import assert from 'node:assert/strict'
import { LINEAR_INDEX_EVENT, issueKeys, parseLinearIndex, withMentions } from './linear-index.mjs'

assert.equal(LINEAR_INDEX_EVENT, 'com.construct.linear')

// Keys and links, once each; not other teams' look-alikes.
assert.deepEqual(issueKeys('Filed BEN-336, see https://linear.app/wunnle/issue/ben-12/title and BEN-336 again.'), ['BEN-12', 'BEN-336'])
assert.deepEqual(issueKeys('UTF-8 and SHA-256, ISO-8601'), [])
assert.deepEqual(issueKeys(undefined), [])

// New mentions go first, newest first; an older entry moves up when mentioned again.
const one = withMentions(undefined, ['BEN-1', 'BEN-2'], '$a', 1000.4)
assert.deepEqual(one, { issues: [{ key: 'BEN-1', eventId: '$a', at: 1000 }, { key: 'BEN-2', eventId: '$a', at: 1000 }] })
const two = withMentions(one, ['BEN-2'], '$b', 2000)
assert.deepEqual(two.issues.map((e) => `${e.key}${e.eventId}`), ['BEN-2$b', 'BEN-1$a'])

// Nothing new: no write. A streamed reply's edits keep the first mention's time.
assert.equal(withMentions(two, [], '$c', 3000), null)
assert.equal(withMentions(two, ['BEN-2'], '$b', 9000), null)

// Pointers only, integers only, capped.
assert.ok(!JSON.stringify(two).includes('title'))
const many = withMentions(undefined, Array.from({ length: 120 }, (_, i) => `BEN-${i}`), '$m', 1)
assert.equal(many.issues.length, 100)

// Malformed state is ignored rather than trusted.
assert.deepEqual(parseLinearIndex({ issues: [{ key: 'BEN-1', eventId: 'x' }, { key: 'BEN-2', eventId: '$y', at: 1.5 }, null] }),
  [{ key: 'BEN-2', eventId: '$y', at: 0 }])
assert.deepEqual(parseLinearIndex(null), [])

console.log('linear index: ok')
