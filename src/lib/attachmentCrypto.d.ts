/** `content.file` of an encrypted m.image / m.file (Matrix spec). */
export interface EncryptedFile {
  url: string
  v?: string
  key: { alg: string; ext: boolean; k: string; key_ops: string[]; kty: string }
  iv: string
  hashes: Record<string, string>
}

export function encryptAttachment(
  plaintext: Uint8Array | ArrayBuffer,
): Promise<{ data: Uint8Array<ArrayBuffer>; file: Omit<EncryptedFile, 'url'> }>

export function decryptAttachment(
  ciphertext: Uint8Array | ArrayBuffer,
  file: Omit<EncryptedFile, 'url'>,
): Promise<Uint8Array<ArrayBuffer>>
