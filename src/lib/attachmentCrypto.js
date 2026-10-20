// Matrix encrypted attachments (spec: client-server API, "Sending encrypted
// attachments"): AES-256-CTR over the file, a SHA-256 of the ciphertext, and
// the key, IV and hash travelling inside the (megolm-encrypted) event as
// `content.file`. The homeserver only ever stores ciphertext.
//
// Plain JavaScript on purpose: the Construct client (browser) and the agent
// bot and scripts/send-image.mjs (Node 22, no TypeScript loader) share this one
// copy. WebCrypto and atob/btoa are globals in both. Types live in
// attachmentCrypto.d.ts.

const subtle = globalThis.crypto.subtle

function toBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** Unpadded standard base64, the spec's encoding for `iv` and `hashes`. */
function encodeUnpadded(bytes) {
  return toBase64(bytes).replace(/=+$/, '')
}

/** Accepts padded or unpadded, standard or url-safe base64. */
function decodeBase64(text) {
  const std = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const binary = atob(std + '='.repeat((4 - (std.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Encrypts `plaintext` for upload. Returns the ciphertext to upload (as
 * application/octet-stream) and the `file` object to put in the event once
 * the upload's mxc:// is known (`{ ...file, url }`).
 */
export async function encryptAttachment(plaintext) {
  const data = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext)
  // Random top 64 bits, zero counter half: the spec's v2 shape, so the counter
  // can't wrap into the random part however large the file.
  const iv = new Uint8Array(16)
  globalThis.crypto.getRandomValues(iv.subarray(0, 8))
  const key = await subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, ['encrypt', 'decrypt'])
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, data))
  const jwk = await subtle.exportKey('jwk', key)
  const hash = new Uint8Array(await subtle.digest('SHA-256', ciphertext))
  return {
    data: ciphertext,
    file: {
      v: 'v2',
      key: { alg: 'A256CTR', ext: true, k: jwk.k, key_ops: ['encrypt', 'decrypt'], kty: 'oct' },
      iv: encodeUnpadded(iv),
      hashes: { sha256: encodeUnpadded(hash) },
    },
  }
}

/**
 * Verifies and decrypts a downloaded encrypted attachment. Throws when the
 * hash is missing or wrong — a tampered or truncated file must not render.
 */
export async function decryptAttachment(ciphertext, file) {
  const data = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext)
  if (!file?.key?.k || !file?.iv) throw new Error('encrypted attachment without key or iv')
  const expected = file.hashes?.sha256
  if (!expected) throw new Error('encrypted attachment without a sha256 hash')
  const actual = encodeUnpadded(new Uint8Array(await subtle.digest('SHA-256', data)))
  if (actual !== String(expected).replace(/=+$/, '')) throw new Error('encrypted attachment hash mismatch')
  const key = await subtle.importKey(
    'jwk',
    { kty: 'oct', k: file.key.k, alg: 'A256CTR', ext: true },
    { name: 'AES-CTR' },
    false,
    ['decrypt'],
  )
  // Unversioned attachments (the oldest clients) used the whole block as the
  // counter; v1 and v2 use the low 64 bits.
  const length = file.v ? 64 : 128
  return new Uint8Array(await subtle.decrypt({ name: 'AES-CTR', counter: decodeBase64(file.iv), length }, key, data))
}
