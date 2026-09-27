import { Capacitor } from '@capacitor/core'

/** Where Construct's own /api endpoints live. */
export const API_ORIGIN = 'https://construct.kafagoz.com'

/**
 * A URL for one of Construct's /api endpoints.
 *
 * On the web a relative path is right: the app and the API share an origin. In
 * the native app the bundle loads from capacitor://localhost, so a relative
 * /api/... resolves against the bundle and fails silently — which had presence
 * and room intents quietly dead in the app. There it has to name the host; the
 * API allows that origin (api/_cors.js).
 */
export function apiUrl(path: string): string {
  return Capacitor.isNativePlatform() ? `${API_ORIGIN}${path}` : path
}
