import assert from 'node:assert/strict'
import { browserContent, browserUrl } from './browser-cards.mjs'
import { verdict } from '../api/frameable.js'

// The card.
const c = browserContent({ url: 'https://example.com/a?b=<c>', title: 'Docs <x>' })
assert.equal(c.body, '🌐 Docs <x>: https://example.com/a?b=<c>', 'other clients get the link')
assert.equal(c.formatted_body, '🌐 <a href="https://example.com/a?b=&lt;c&gt;">Docs &lt;x&gt;</a>', 'escaped')
assert.deepEqual(c['com.construct.browser'], { url: 'https://example.com/a?b=<c>', title: 'Docs <x>' })
assert.ok(c['com.construct.machine'], 'the agent\'s reply already notifies')
const bare = browserContent({ url: 'https://example.com/', title: '' })
assert.deepEqual(bare['com.construct.browser'], { url: 'https://example.com/' }, 'no empty title')
assert.equal(bare.body, '🌐 example.com: https://example.com/', 'the host stands in for a title')

assert.equal(browserUrl('https://bender.tale-bellatrix.ts.net:5173'), 'https://bender.tale-bellatrix.ts.net:5173/')
assert.equal(browserUrl('javascript:alert(1)'), null)
assert.equal(browserUrl('file:///etc/passwd'), null)
assert.equal(browserUrl('example.com'), null, 'a bare host is not a URL here')

// Reading the framing headers.
const h = (o) => new Headers(o)
assert.deepEqual(verdict(h({})), { frameable: true }, 'no headers, no refusal')
assert.equal(verdict(h({ 'x-frame-options': 'DENY' })).frameable, false)
assert.equal(verdict(h({ 'x-frame-options': 'sameorigin' })).frameable, false)
assert.equal(verdict(h({ 'x-frame-options': 'ALLOW-FROM https://construct.kafagoz.com' })).frameable, false, 'ALLOW-FROM is ignored by browsers')
assert.equal(verdict(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" })).frameable, false)
assert.equal(verdict(h({ 'content-security-policy': "frame-ancestors 'none'" })).frameable, false)
assert.equal(verdict(h({ 'content-security-policy': 'frame-ancestors *' })).frameable, true)
assert.equal(verdict(h({ 'content-security-policy': 'frame-ancestors https:' })).frameable, true)
assert.equal(verdict(h({ 'content-security-policy': 'frame-ancestors https://construct.kafagoz.com' })).frameable, true)
assert.equal(verdict(h({ 'content-security-policy': 'frame-ancestors https://*.kafagoz.com' })).frameable, true)
assert.equal(verdict(h({ 'content-security-policy': 'frame-ancestors https://other.com' })).frameable, false)
assert.equal(verdict(h({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' })).frameable, true, 'frame-ancestors wins over X-Frame-Options')
assert.equal(verdict(h({ 'content-security-policy': "script-src 'self'", 'x-frame-options': 'DENY' })).frameable, false, 'a CSP without frame-ancestors leaves X-Frame-Options in charge')
// Two policies (two headers, joined with a comma): both must allow it.
assert.equal(verdict(h({ 'content-security-policy': "frame-ancestors *, frame-ancestors 'self'" })).frameable, false)

console.log('browser cards ok')
