import { loadAuth } from './auth'

/**
 * Device token for Construct's /api endpoints (BEN-378).
 *
 * Vercel checks a Matrix token by asking its homeserver, which it can't do for
 * the tailnet-only kafagoz.com server. So a client signed in there asks the Pi
 * instead: scripts/construct-device-token.mjs, mounted at /_construct on the
 * same tailnet host as the homeserver. The Pi checks the Matrix token with the
 * homeserver and returns a signed token that Vercel can verify by itself (see
 * api/_device-token.js). It lasts 30 days and is renewed on launch once it's
 * past halfway.
 *
 * Accounts on matrix.org don't need one. Vercel can check their token directly.
 */

const KEY = 'construct:device-token'
const RENEW_BEFORE_MS = 15 * 24 * 60 * 60 * 1000

interface Stored { token: string; expiresAt: number; userId: string }

function read(): Stored | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return v && typeof v.token === 'string' && typeof v.expiresAt === 'number' ? v : null
  } catch {
    return null
  }
}

/** The stored device token if it belongs to the signed-in user and hasn't
    expired, else null. */
export function deviceToken(): string | null {
  const s = read()
  const auth = loadAuth()
  if (!s || !auth || s.userId !== auth.userId || s.expiresAt - Date.now() < 60_000) return null
  return s.token
}

function needsDeviceToken(homeserver: string): boolean {
  try {
    const host = new URL(homeserver).hostname
    return host !== 'matrix.org' && !host.endsWith('.matrix.org')
  } catch {
    return false
  }
}

let inflight: Promise<string | null> | null = null

/** Mint or renew the device token when it's missing or past halfway. Never
    throws: off the tailnet, or on an older Pi, the client falls back to
    sending its Matrix token, which is what it did before. */
export function refreshDeviceToken(): Promise<string | null> {
  if (inflight) return inflight
  inflight = (async () => {
    const auth = loadAuth()
    if (!auth?.accessToken || !needsDeviceToken(auth.homeserver)) return null
    const s = read()
    if (s && s.userId === auth.userId && s.expiresAt - Date.now() > RENEW_BEFORE_MS) return s.token
    try {
      const r = await fetch(`${auth.homeserver.replace(/\/$/, '')}/_construct/device-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      })
      if (!r.ok) return deviceToken()
      const j = await r.json()
      if (typeof j?.token !== 'string' || typeof j?.expiresAt !== 'number') return deviceToken()
      localStorage.setItem(KEY, JSON.stringify({ token: j.token, expiresAt: j.expiresAt, userId: auth.userId }))
      return j.token as string
    } catch {
      return deviceToken()
    }
  })().finally(() => { inflight = null })
  return inflight
}

export function clearDeviceToken(): void {
  try { localStorage.removeItem(KEY) } catch { /* storage unavailable */ }
}
