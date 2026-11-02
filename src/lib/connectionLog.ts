import * as sdk from 'matrix-js-sdk'

/**
 * A per-device record of the Matrix connection's health: sync state changes,
 * failed or slow homeserver requests, network on/off, and the app going to the
 * background and back. Kept in localStorage so it survives reloads, and copied
 * out from Settings when a "stuck/disconnected" report needs explaining.
 * Healthy traffic is not logged, so the buffer holds days of incidents.
 */
const LOG_KEY = 'construct:connection-log'
const MAX_LINES = 600
// A /sync long-poll is held open for up to 30s by design; anything else this
// slow is worth a line.
const SLOW_MS = 10_000
const SLOW_SYNC_MS = 45_000

function read(): string[] {
  try {
    const raw = localStorage.getItem(LOG_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function logConnection(message: string) {
  const lines = read()
  lines.push(`${new Date().toISOString()} ${message}`)
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(lines.slice(-MAX_LINES)))
  } catch { /* storage full or blocked: drop the line */ }
}

export function getConnectionLog(): string {
  return read().join('\n')
}

export function clearConnectionLog() {
  try { localStorage.removeItem(LOG_KEY) } catch { /* ignore */ }
}

// The path without the API prefix and query string, which is where an access
// token would sit if anything ever put one there.
function shortPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/_matrix\/client\/v\d+/, '')
  } catch {
    return '?'
  }
}

/** A fetch for createClient's fetchFn that logs failures and slow responses. */
export const loggingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = init?.method ?? 'GET'
  const path = shortPath(url)
  const started = Date.now()
  try {
    const res = await fetch(input, init)
    const ms = Date.now() - started
    if (res.status === 429 || res.status >= 500) {
      logConnection(`HTTP ${res.status} ${method} ${path} (${ms}ms)`)
    } else if (ms > (path === '/sync' ? SLOW_SYNC_MS : SLOW_MS)) {
      logConnection(`slow ${res.status} ${method} ${path} (${ms}ms)`)
    }
    return res
  } catch (e) {
    const err = e as Error
    // The SDK aborts its own sync request when it stops or restarts the loop.
    if (err?.name !== 'AbortError') {
      logConnection(`fetch failed ${method} ${path} after ${Date.now() - started}ms: ${err?.name} ${err?.message}`)
    }
    throw e
  }
}

let installed = false

/** Start logging sync state and app lifecycle for this client. Call once, before startClient. */
export function startConnectionLog(client: sdk.MatrixClient) {
  let downSince: number | null = null
  client.on(sdk.ClientEvent.Sync, (state, prev, data) => {
    if (state === prev) return
    if (state === 'SYNCING' || state === 'PREPARED') {
      if (downSince !== null) {
        logConnection(`sync recovered (${prev} → ${state}) after ${Math.round((Date.now() - downSince) / 1000)}s`)
        downSince = null
      } else if (state === 'PREPARED') {
        logConnection('sync prepared')
      }
      return
    }
    downSince ??= Date.now()
    const err = data?.error as (Error & { httpStatus?: number }) | undefined
    logConnection(`sync ${prev ?? 'none'} → ${state}${err ? `: ${err.name} ${err.httpStatus ?? ''} ${err.message}` : ''}`)
  })

  if (installed) return
  installed = true
  const native = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
  logConnection(`app start v${__CONSTRUCT_VERSION__} ${native ? 'native' : 'web'} ${navigator.onLine ? 'online' : 'offline'}`)
  window.addEventListener('online', () => logConnection('network online'))
  window.addEventListener('offline', () => logConnection('network offline'))
  // iOS suspends a backgrounded app, so a reconnect right after coming back is
  // expected; this line tells that apart from a drop while in use. Quick app
  // switches are left out so they don't crowd incidents out of the buffer.
  let hiddenAt: number | null = null
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
    } else if (hiddenAt !== null) {
      const away = Math.round((Date.now() - hiddenAt) / 1000)
      if (away >= 30) logConnection(`app resumed after ${away}s in background`)
      hiddenAt = null
    }
  })
}
