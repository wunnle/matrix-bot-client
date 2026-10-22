import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ARTIFACT_INDEX_EVENT, artifactContent, artifactEdit, artifactIndex, createArtifactRegistry } from './artifact-cards.mjs'

const c = artifactContent({ url: 'https://claude.ai/artifact/A', title: 'Q3 <Plan>', description: 'The plan.', version: 2 })
assert.equal(c.body, '📄 Q3 <Plan>: https://claude.ai/artifact/A', 'other clients get the link')
assert.equal(c.formatted_body, '📄 <a href="https://claude.ai/artifact/A">Q3 &lt;Plan&gt;</a>', 'the title is escaped')
assert.deepEqual(c['com.construct.artifact'], { url: 'https://claude.ai/artifact/A', title: 'Q3 <Plan>', description: 'The plan.', version: 2 })
assert.ok(c['com.construct.machine'], 'the agent\'s reply already notifies')
const bare = artifactContent({ url: 'https://claude.ai/artifact/B', title: 'B' })
assert.deepEqual(bare['com.construct.artifact'], { url: 'https://claude.ai/artifact/B', title: 'B' }, 'no undefined fields')

const snap = artifactContent({ url: 'https://claude.ai/artifact/C', title: 'C', file: '/home/wunnle/secret/dir/page.html', snapshot: { file: { url: 'mxc://x/y' }, size: 10 } })
assert.deepEqual(snap['com.construct.artifact'].snapshot, { file: { url: 'mxc://x/y' }, size: 10 })
assert.ok(!JSON.stringify(snap).includes('/home/wunnle'), 'the local path never reaches the room')

// The index: pointers only, newest first, nothing a homeserver could read.
const idx = artifactIndex({
  'https://claude.ai/artifact/OLD': { eventId: '$old', version: 5 },
  'https://claude.ai/code/artifact/0f-9a': { eventId: '$code', version: 1, updatedAt: 2000.7 },
  'https://claude.ai/artifact/NEW': { eventId: '$new', version: 2, updatedAt: 3000, title: 'Secret plan' },
  'https://example.com/x': { eventId: '$bad' },
  'https://claude.ai/artifact/NOEVENT': { version: 1 },
})
assert.deepEqual(idx, { artifacts: [
  { id: 'NEW', eventId: '$new', updatedAt: 3000 },
  { id: '0f-9a', eventId: '$code', updatedAt: 2001 },
  { id: 'OLD', eventId: '$old', updatedAt: 0 },
] })
assert.ok(!JSON.stringify(idx).includes('Secret'), 'no titles in unencrypted room state')
assert.deepEqual(artifactIndex(undefined), { artifacts: [] })
assert.equal(ARTIFACT_INDEX_EVENT, 'com.construct.artifacts')

const e = artifactEdit('$first', c)
assert.deepEqual(e['m.relates_to'], { rel_type: 'm.replace', event_id: '$first' })
assert.equal(e['m.new_content'], c)
assert.ok(e['com.construct.machine'], 'an edit never pushes either')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-cards-'))
const file = path.join(dir, 'artifacts.json')
const reg = createArtifactRegistry(file)
assert.equal(reg.get('!r', 'https://claude.ai/artifact/A'), null)
reg.set('!r', 'https://claude.ai/artifact/A', { eventId: '$a', version: 1 })
reg.set('!r', 'https://claude.ai/artifact/A', { eventId: '$a', version: 2 })
assert.deepEqual(createArtifactRegistry(file).get('!r', 'https://claude.ai/artifact/A'), { eventId: '$a', version: 2 }, 'survives a restart')
assert.deepEqual(createArtifactRegistry(file).rooms(), ['!r'])
assert.deepEqual(Object.keys(createArtifactRegistry(file).entries('!r')), ['https://claude.ai/artifact/A'])
assert.deepEqual(createArtifactRegistry(file).entries('!nobody'), {})
assert.equal(createArtifactRegistry(file).get('!other', 'https://claude.ai/artifact/A'), null, 'per room')
fs.writeFileSync(file, '{broken')
assert.equal(createArtifactRegistry(file).get('!r', 'x'), null, 'a corrupt file is an empty registry')
fs.rmSync(dir, { recursive: true, force: true })

console.log('artifact cards: ok')
