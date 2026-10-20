import type { MatrixClient } from 'matrix-js-sdk'
import { decryptAttachment, type EncryptedFile } from './attachmentCrypto.js'

const cache = new Map<string, string>()
const base64Cache = new Map<string, string>()

/** Fetch an mxc image (with auth) and return raw base64 — for handing image
 *  bytes to native code (e.g. share-suggestion avatars). */
export async function resolveMediaBase64(
  client: MatrixClient,
  mxc: string,
  width?: number,
  height?: number,
  resizeMethod?: string,
): Promise<string | null> {
  if (!mxc) return null
  const key = `${mxc}:${width}:${height}:${resizeMethod}`
  if (base64Cache.has(key)) return base64Cache.get(key)!
  const url = client.mxcUrlToHttp(mxc, width, height, resizeMethod, false, false, true)
  if (!url) return null
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${client.getAccessToken()}` } })
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    const b64 = btoa(binary)
    base64Cache.set(key, b64)
    return b64
  } catch {
    return null
  }
}

/** An encrypted attachment (`content.file` from an encrypted room). The
 *  homeserver holds only ciphertext, so it can't make thumbnails: always
 *  fetched full size, then verified and decrypted here. */
export interface EncryptedMedia {
  file: EncryptedFile
  mimetype?: string
}

export async function resolveMediaUrl(
  client: MatrixClient,
  mxc: string,
  width?: number,
  height?: number,
  resizeMethod?: string,
  encrypted?: EncryptedMedia,
): Promise<string | null> {
  if (!mxc) return null
  if (encrypted) {
    width = undefined
    height = undefined
    resizeMethod = undefined
  }
  const key = `${mxc}:${width}:${height}:${resizeMethod}`
  if (cache.has(key)) return cache.get(key)!

  const url = client.mxcUrlToHttp(mxc, width, height, resizeMethod, false, false, true)
  if (!url) return null

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${client.getAccessToken()}` },
    })
    if (!res.ok) return null
    const blob = encrypted
      ? new Blob([await decryptAttachment(await res.arrayBuffer(), encrypted.file)], {
          type: encrypted.mimetype || 'application/octet-stream',
        })
      : await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    cache.set(key, objectUrl)
    return objectUrl
  } catch {
    return null
  }
}
