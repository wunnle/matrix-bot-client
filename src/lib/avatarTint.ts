/**
 * An agent's colour for tinting its bubbles in rooms with several agents: the
 * dominant hue of its avatar, so the bubble matches the face beside it.
 *
 * Returns "H S%" for use as `hsl(var(--agent-tint) L% / A)`. Grey or missing
 * avatars fall back to a stable hue from the user id, so every agent still
 * gets a distinct colour.
 */

const cache = new Map<string, Promise<string | null>>()

/** Stable hue from a string (golden-angle spread, same trick as DiscordView). */
export function hashTint(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  const hue = Math.round((Math.abs(hash) % 1000) * 137.508) % 360
  return `${hue} 55%`
}

/** Dominant saturated hue of an image URL (a same-origin blob URL from
 *  resolveMediaUrl, so the canvas isn't tainted). Null if it has no colour. */
export function avatarTint(url: string): Promise<string | null> {
  let p = cache.get(url)
  if (!p) {
    p = sample(url).catch(() => null)
    cache.set(url, p)
  }
  return p
}

function sample(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const size = 24
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) { resolve(null); return }
      ctx.drawImage(img, 0, 0, size, size)
      let data: Uint8ClampedArray
      try { data = ctx.getImageData(0, 0, size, size).data } catch { resolve(null); return }

      // Average hue as a vector, weighted by saturation, so the colourful parts
      // of the avatar win over its background, outlines and highlights.
      let x = 0, y = 0, satSum = 0, weight = 0, pixels = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue
        pixels++
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255
        const max = Math.max(r, g, b), min = Math.min(r, g, b)
        const l = (max + min) / 2
        const d = max - min
        if (d < 0.08 || l < 0.12 || l > 0.92) continue
        const s = d / (1 - Math.abs(2 * l - 1))
        let h: number
        if (max === r) h = ((g - b) / d) % 6
        else if (max === g) h = (b - r) / d + 2
        else h = (r - g) / d + 4
        const rad = (h * 60 * Math.PI) / 180
        x += Math.cos(rad) * s
        y += Math.sin(rad) * s
        satSum += s * s
        weight += s
      }
      // Too few coloured pixels: a grey or monochrome avatar has no hue to borrow.
      if (!pixels || weight / pixels < 0.06) { resolve(null); return }
      const hue = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360)
      const sat = Math.round(Math.min(75, Math.max(55,(satSum / weight) * 100)))
      resolve(`${hue} ${sat}%`)
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}
