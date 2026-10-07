import type { SharedLocation } from '../types'

// geo:41.0123,28.9876;u=12 (RFC 5870). Altitude, if present, is ignored.
export function parseGeoUri(uri: unknown): SharedLocation | undefined {
  if (typeof uri !== 'string') return undefined
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,[^;]*)?((?:;[^;]*)*)$/i.exec(uri.trim())
  if (!m) return undefined
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  const u = /;u=(\d+(?:\.\d+)?)/i.exec(m[3])
  return { lat, lon, accuracy: u ? Number(u[1]) : undefined }
}

// Matrix has two shapes for this: the classic msgtype's geo_uri, and the
// extensible-events block newer clients (Element) also send.
type LocationBlock = { uri?: unknown, description?: unknown } | undefined

export function locationFromContent(content: Record<string, unknown> | undefined): SharedLocation | undefined {
  if (content?.msgtype !== 'm.location') return undefined
  const block = (content['org.matrix.msc3488.location'] ?? content['m.location']) as LocationBlock
  const loc = parseGeoUri(content.geo_uri) ?? parseGeoUri(block?.uri)
  if (!loc) return undefined
  const description = block?.description
  return typeof description === 'string' && description ? { ...loc, description } : loc
}

export function formatCoords({ lat, lon }: SharedLocation): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
}

// Google Maps everywhere: a universal link, so it opens the app when it's
// installed and the website otherwise.
export function mapsUrl({ lat, lon }: SharedLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
}

// One fresh fix. High accuracy because "where am I" a block off is the wrong
// answer, and a cached fix up to a minute old is fine for a one-off share.
export function currentLocation(): Promise<SharedLocation> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Location is not available on this device.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy),
      }),
      (err) => reject(new Error(
        err.code === err.PERMISSION_DENIED ? 'Location permission was denied.'
          : err.code === err.TIMEOUT ? 'Timed out finding your location.'
          : 'Could not find your location.',
      )),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  })
}

// The body is what bots and plain clients read, so it carries everything:
// coordinates, accuracy and a link a human can open.
export function locationContent(loc: SharedLocation): Record<string, unknown> {
  const geoUri = `geo:${loc.lat},${loc.lon}${loc.accuracy != null ? `;u=${loc.accuracy}` : ''}`
  const accuracy = loc.accuracy != null ? ` (±${loc.accuracy} m)` : ''
  return {
    msgtype: 'm.location',
    body: `📍 Shared location: ${formatCoords(loc)}${accuracy} ${mapsUrl(loc)}`,
    geo_uri: geoUri,
    'org.matrix.msc3488.location': { uri: geoUri },
    'org.matrix.msc3488.asset': { type: 'm.self' },
    'org.matrix.msc3488.ts': Date.now(),
  }
}
