import { Capacitor } from '@capacitor/core'
import { Geolocation } from '@capacitor/geolocation'
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
const FIX_OPTIONS = { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 }

export function currentLocation(): Promise<SharedLocation> {
  return Capacitor.isNativePlatform() ? nativeLocation() : webLocation()
}

// In the app, the WebView's own geolocation asks again ("localhost would like
// to use your location") every launch on top of the iOS prompt. The native
// plugin goes through iOS permission alone, which is asked once and remembered.
async function nativeLocation(): Promise<SharedLocation> {
  let { location } = await Geolocation.checkPermissions()
  if (location === 'prompt' || location === 'prompt-with-rationale') {
    ({ location } = await Geolocation.requestPermissions({ permissions: ['location'] }))
  }
  if (location === 'denied') throw new Error('Location permission was denied. Allow it in Settings › Construct.')
  return watchForFix()
}

// The plugin's getCurrentPosition is iOS requestLocation() at best accuracy,
// which ignores maximumAge and holds out several seconds for its finest fix.
// Watching instead hands back the last known fix almost at once and refines
// from there: send the first one inside GOOD_ENOUGH_M, or the best by SETTLE_MS.
const GOOD_ENOUGH_M = 50
const SETTLE_MS = 4_000

function watchForFix(): Promise<SharedLocation> {
  return new Promise((resolve, reject) => {
    let best: SharedLocation | undefined
    let done = false
    const finish = (err?: Error) => {
      if (done) return
      done = true
      clearTimeout(settle)
      clearTimeout(giveUp)
      void watchId.then((id) => Geolocation.clearWatch({ id }))
      if (best) resolve(best)
      else reject(err ?? new Error('Could not find your location.'))
    }
    const settle = setTimeout(() => { if (best) finish() }, SETTLE_MS)
    const giveUp = setTimeout(() => finish(new Error('Timed out finding your location.')), FIX_OPTIONS.timeout)
    const watchId = Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
      if (done) return
      if (!pos) {
        if (err) finish(new Error('Could not find your location.'))
        return
      }
      // The last known fix can be from hours ago, somewhere else.
      if (Date.now() - pos.timestamp > FIX_OPTIONS.maximumAge) return
      const fix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy),
      }
      if (!best || fix.accuracy < (best.accuracy ?? Infinity)) best = fix
      if (fix.accuracy <= GOOD_ENOUGH_M) finish()
    })
    watchId.catch(() => finish(new Error('Could not find your location.')))
  })
}

function webLocation(): Promise<SharedLocation> {
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
      FIX_OPTIONS,
    )
  })
}

// The body is what bots and plain clients read, so it carries everything:
// the place name if one was picked, coordinates, accuracy and a link a human
// can open. A picked place is a pin (m.pin); otherwise it's the sender (m.self).
export function locationContent(loc: SharedLocation, kind: 'self' | 'pin' = 'self'): Record<string, unknown> {
  const geoUri = `geo:${loc.lat},${loc.lon}${loc.accuracy != null ? `;u=${loc.accuracy}` : ''}`
  const accuracy = loc.accuracy != null ? ` (±${loc.accuracy} m)` : ''
  const label = loc.description ?? (kind === 'pin' ? 'Pinned location' : 'Shared location')
  return {
    msgtype: 'm.location',
    body: `📍 ${label}: ${formatCoords(loc)}${accuracy} ${mapsUrl(loc)}`,
    geo_uri: geoUri,
    'org.matrix.msc3488.location': loc.description ? { uri: geoUri, description: loc.description } : { uri: geoUri },
    'org.matrix.msc3488.asset': { type: kind === 'pin' ? 'm.pin' : 'm.self' },
    'org.matrix.msc3488.ts': Date.now(),
  }
}
