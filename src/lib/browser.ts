import { Capacitor, registerPlugin } from '@capacitor/core'
import { apiUrl } from './apiUrl'
import { intentCredential } from './matrix'

/**
 * The room sidebar's Browser tab: a page open beside the chat. The user types
 * an address, or an agent sends one (`construct-browse`, which posts a
 * `com.construct.browser` card; scripts/browser-cards.mjs).
 *
 * The sidebar runs on the phone or the Mac, never on the Pi, so `localhost`
 * there is the device itself. Pi dev servers arrive as tailnet addresses
 * (`tailscale serve`, see scripts/construct-preview.mjs), and pages that refuse
 * to be framed open outside instead.
 */
export interface ConstructBrowserPage {
  url: string
  title?: string
}

/** com.construct.browser from message content, or undefined when it isn't a valid one. */
export function parseBrowserPage(value: unknown): ConstructBrowserPage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const url = typeof raw.url === 'string' ? webUrl(raw.url) : null
  if (!url) return undefined
  return { url, title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined }
}

function webUrl(s: string): string | null {
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch { return null }
}

/** What was typed in the address bar as a URL: https:// unless it says otherwise. */
export function addressToUrl(input: string): string | null {
  const s = input.trim()
  if (!s || /\s/.test(s)) return null
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(s)) return webUrl(s)
  // localhost:5173 and 127.0.0.1 have no dots worth trusting; say http so
  // the "that's this device" note can explain it.
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(s)
  return webUrl(`${local ? 'http' : 'https'}://${s}`)
}

/**
 * Where a URL points, as far as framing it goes:
 *  - local: this device (localhost), not the Pi
 *  - tailnet: a Tailscale address, ours by definition; framed without asking
 *  - insecure: plain http, which an https app can't frame (mixed content)
 *  - web: anything else; ask /api/frameable first
 */
export type Reach = 'local' | 'tailnet' | 'insecure' | 'web'

export function reachOf(url: string): Reach {
  const { hostname, protocol } = new URL(url)
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)) return 'local'
  if (protocol === 'http:') return 'insecure'
  if (host.endsWith('.ts.net') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'tailnet'
  return 'web'
}

export interface FrameCheck {
  /** null: couldn't tell (unreachable from the server, or the check failed). */
  frameable: boolean | null
}

const checks = new Map<string, Promise<FrameCheck>>()

/** Whether the page lets Construct frame it, by its headers (api/frameable.js). */
export function checkFrameable(url: string): Promise<FrameCheck> {
  let check = checks.get(url)
  if (!check) {
    const secret = intentCredential()
    check = fetch(apiUrl(`/api/frameable?url=${encodeURIComponent(url)}`), {
      headers: secret ? { 'x-intent-secret': secret } : {},
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => ({ frameable: typeof j?.frameable === 'boolean' ? j.frameable : null }))
      .catch(() => ({ frameable: null }))
    checks.set(url, check)
    // A failed check is asked again next time.
    void check.then((c) => { if (c.frameable === null) checks.delete(url) })
  }
  return check
}

// @capacitor/browser's native half: SFSafariViewController on iOS. Called by
// name, so the web code doesn't wait on the package; the installed app may
// predate the plugin, so every call falls back to a plain new window.
const nativeBrowser = registerPlugin<{ open(options: { url: string }): Promise<void> }>('Browser')

/** Opens the page outside the panel: the in-app browser on native, a tab on the web. */
export async function openOutside(url: string): Promise<void> {
  // On the web, open in the click itself: Safari blocks a window opened later.
  if (!Capacitor.isNativePlatform()) { window.open(url, '_blank', 'noopener,noreferrer'); return }
  try {
    await nativeBrowser.open({ url })
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

// The page last open in each room's Browser tab, on this device.
const pageKey = (roomId: string) => `room-browser:${roomId}`

export function storedPage(roomId: string): string | null {
  try { return localStorage.getItem(pageKey(roomId)) } catch { return null }
}

export function storePage(roomId: string, url: string | null): void {
  try {
    if (url) localStorage.setItem(pageKey(roomId), url)
    else localStorage.removeItem(pageKey(roomId))
  } catch { /* private mode: the page just isn't remembered */ }
}

/**
 * The pages opened in a room's Browser tab, oldest first, and which one is
 * showing. Kept on this device so Back and History survive switching tabs,
 * closing the panel and leaving the room.
 */
export interface BrowserHistory {
  stack: string[]
  at: number
}

const HISTORY_MAX = 50
const historyKey = (roomId: string) => `room-browser-history:${roomId}`

export function storedHistory(roomId: string): BrowserHistory {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey(roomId)) ?? 'null') as Partial<BrowserHistory> | null
    const stack = Array.isArray(raw?.stack) ? raw.stack.filter((u): u is string => typeof u === 'string' && !!webUrl(u)) : []
    if (stack.length) {
      const at = typeof raw?.at === 'number' && raw.at >= 0 && raw.at < stack.length ? raw.at : stack.length - 1
      return { stack, at }
    }
  } catch { /* unreadable: start over */ }
  // Rooms from before the history was kept still have their last page.
  const page = storedPage(roomId)
  return page ? { stack: [page], at: 0 } : { stack: [], at: -1 }
}

export function storeHistory(roomId: string, history: BrowserHistory): void {
  const drop = Math.max(0, history.stack.length - HISTORY_MAX)
  const kept = { stack: history.stack.slice(drop), at: Math.max(-1, history.at - drop) }
  try { localStorage.setItem(historyKey(roomId), JSON.stringify(kept)) } catch { /* private mode */ }
}
