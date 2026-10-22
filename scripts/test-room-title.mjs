import assert from 'node:assert/strict'
import { cleanTitle, fallbackTitle, titlePrompt } from './room-title.mjs'

assert.equal(cleanTitle('Digest Calendar\n'), 'Digest Calendar')
assert.equal(cleanTitle('"Playlist Temizleme."'), 'Playlist Temizleme')
assert.equal(cleanTitle('\n\n**Display Comparison**'), 'Display Comparison')
assert.equal(cleanTitle('Error Handling'), 'Error Handling', 'a real word, not a failure')
assert.equal(cleanTitle('Not logged in · Please run /login'), null)
assert.equal(cleanTitle(''), null)
assert.equal(cleanTitle('Kitchen Calendar E-Ink Display Comparison'), 'Kitchen Calendar E-Ink', 'cut at a word under 24')
assert.equal(cleanTitle('Supercalifragilisticexpialidocious'), 'Supercalifragilisticexpi', 'one long word is cut hard')

assert.equal(fallbackTitle('can you check why the morning digest skipped'), 'Can You Check')
assert.equal(fallbackTitle('ışıkları kapat, lütfen!'), 'Işıkları Kapat Lütfen', 'Turkish casing')
assert.equal(fallbackTitle('!!! ???'), null)

const p = titlePrompt('fix "it"\nnow')
assert.ok(p.includes('Request: "fix \\"it\\"\\nnow"'), 'the request is quoted, not spliced into the instructions')
assert.ok(titlePrompt('x'.repeat(5000)).length < 2400, 'long prompts are capped')

console.log('room title: ok')
