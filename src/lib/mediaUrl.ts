import type { MatrixClient } from 'matrix-js-sdk'

const cache = new Map<string, string>()

export async function resolveMediaUrl(
  client: MatrixClient,
  mxc: string,
  width?: number,
  height?: number,
  resizeMethod?: string,
): Promise<string | null> {
  if (!mxc) return null
  const key = `${mxc}:${width}:${height}:${resizeMethod}`
  if (cache.has(key)) return cache.get(key)!

  const url = client.mxcUrlToHttp(mxc, width, height, resizeMethod, false, false, true)
  if (!url) return null

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${client.getAccessToken()}` },
    })
    if (!res.ok) return null
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    cache.set(key, objectUrl)
    return objectUrl
  } catch {
    return null
  }
}
