import { Capacitor } from '@capacitor/core'
import { loadAuth } from './auth'

/** Where Construct's own /api endpoints live. */
export const API_ORIGIN = 'https://construct.kafagoz.com'

/** Routes that depend on the homeserver. For an account on the self-hosted
    server they're served by the Pi (scripts/construct-api.mjs), since Vercel
    can't reach that server and keeps its state on matrix.org (BEN-379). */
const PI_ROUTES = new Set(['activity', 'live-activity', 'send-message', 'send-file', 'wait-reply', 'widget'])

/**
 * The Pi's API base for the signed-in account, or null when Vercel serves it
 * (matrix.org accounts). The Pi is mounted at /_construct on the same tailnet
 * host as the homeserver, so the base follows from the homeserver URL.
 */
export function piApiBase(): string | null {
  const hs = loadAuth()?.homeserver
  if (!hs) return null
  try {
    const host = new URL(hs).hostname
    if (host === 'matrix.org' || host.endsWith('.matrix.org')) return null
  } catch {
    return null
  }
  return `${hs.replace(/\/$/, '')}/_construct`
}

/**
 * A URL for one of Construct's /api endpoints.
 *
 * Homeserver-backed routes go to the Pi for a self-hosted account. Otherwise,
 * on the web a relative path is right: the app and the API share an origin. In
 * the native app the bundle loads from capacitor://localhost, so a relative
 * /api/... resolves against the bundle and fails silently — which had presence
 * and room intents quietly dead in the app. There it has to name the host; the
 * API allows that origin (api/_cors.js).
 */
export function apiUrl(path: string): string {
  const route = path.match(/^\/api\/([a-z-]+)/)?.[1]
  const pi = route && PI_ROUTES.has(route) ? piApiBase() : null
  if (pi) return `${pi}${path}`
  return Capacitor.isNativePlatform() ? `${API_ORIGIN}${path}` : path
}
