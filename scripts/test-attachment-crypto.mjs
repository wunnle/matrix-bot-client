// Encrypted attachments (src/lib/attachmentCrypto.js): round trip, the event
// shape the spec asks for, an independent decrypt with node:crypto, and that a
// tampered file is refused rather than rendered.
// Run: node scripts/test-attachment-crypto.mjs
import assert from 'node:assert/strict'
import nodeCrypto from 'node:crypto'
import { encryptAttachment, decryptAttachment } from '../src/lib/attachmentCrypto.js'

const plain = nodeCrypto.randomBytes(100_003) // not a multiple of the block size
const { data, file } = await encryptAttachment(plain)

// Shape
assert.equal(file.v, 'v2')
assert.equal(file.key.alg, 'A256CTR')
assert.equal(file.key.kty, 'oct')
assert.deepEqual(file.key.key_ops, ['encrypt', 'decrypt'])
assert.equal(file.key.ext, true)
assert.ok(!file.iv.endsWith('='), 'iv is unpadded')
assert.ok(!file.hashes.sha256.endsWith('='), 'hash is unpadded')
const iv = Buffer.from(file.iv, 'base64')
assert.equal(iv.length, 16)
assert.ok(iv.subarray(8).every((b) => b === 0), 'counter half of the iv starts at zero')
assert.equal(data.length, plain.length)
assert.notDeepEqual(Buffer.from(data), plain)

// Round trip
assert.deepEqual(Buffer.from(await decryptAttachment(data, file)), plain)

// Independent implementation: what any other Matrix client would compute.
const key = Buffer.from(file.key.k, 'base64url')
const decipher = nodeCrypto.createDecipheriv('aes-256-ctr', key, iv)
assert.deepEqual(Buffer.concat([decipher.update(data), decipher.final()]), plain)
assert.equal(
  nodeCrypto.createHash('sha256').update(data).digest('base64').replace(/=+$/, ''),
  file.hashes.sha256,
)

// And the other direction: a file another client encrypted.
const otherKey = nodeCrypto.randomBytes(32)
const otherIv = Buffer.concat([nodeCrypto.randomBytes(8), Buffer.alloc(8)])
const cipher = nodeCrypto.createCipheriv('aes-256-ctr', otherKey, otherIv)
const otherData = Buffer.concat([cipher.update(plain), cipher.final()])
const otherFile = {
  v: 'v2',
  key: { alg: 'A256CTR', ext: true, k: otherKey.toString('base64url'), key_ops: ['encrypt', 'decrypt'], kty: 'oct' },
  iv: otherIv.toString('base64'), // padded, as some clients send it
  hashes: { sha256: nodeCrypto.createHash('sha256').update(otherData).digest('base64') },
}
assert.deepEqual(Buffer.from(await decryptAttachment(otherData, otherFile)), plain)

// Tampering
const bad = Uint8Array.from(data)
bad[10] ^= 1
await assert.rejects(decryptAttachment(bad, file), /hash mismatch/)
await assert.rejects(decryptAttachment(data, { ...file, hashes: {} }), /sha256/)

console.log('attachment crypto: ok')
