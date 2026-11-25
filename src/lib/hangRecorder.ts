import type * as sdk from 'matrix-js-sdk'

/**
 * A flight recorder for the "app stops taking clicks after a while" freeze.
 * Every few seconds it saves a small snapshot to localStorage: how late the
 * timer fired (a stuck main thread shows as lag), how much the SDK holds, how
 * big the page is, and what sits on top at the middle of the screen. It also
 * keeps the last few pointer-downs and what they landed on, so a click eaten
 * by an invisible layer shows up as a hit on that layer.
 *
 * On start the previous session's record moves aside, so after a forced
 * restart Settings → Copy connection log carries what led up to the freeze.
 */
const KEY = 'construct:hang-recorder'
const PREV_KEY = 'construct:hang-recorder:prev'
const TICK_MS = 3000
const MAX_SNAPS = 40
const MAX_TAPS = 12

interface Snap {
  t: string
  lag: number
  dom: number
  ev: number
  top: string
  rooms: number
  vis: string
  path: string
  over: string
}

interface Record_ {
  started: string
  version: string
  snaps: Snap[]
  taps: string[]
  ended?: string
}

function describe(el: Element | null): string {
  if (!el) return '-'
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
}

function save(rec: Record_) {
  try { localStorage.setItem(KEY, JSON.stringify(rec)) } catch { /* storage full or blocked */ }
}

let started = false

export function startHangRecorder(client: sdk.MatrixClient) {
  if (started) return
  started = true
  try {
    const prev = localStorage.getItem(KEY)
    if (prev) localStorage.setItem(PREV_KEY, prev)
  } catch { /* ignore */ }

  const rec: Record_ = { started: new Date().toISOString(), version: __CONSTRUCT_VERSION__, snaps: [], taps: [] }
  let expected = Date.now() + TICK_MS

  const tick = () => {
    const now = Date.now()
    // Throttled background timers fire late by design; only lag while
    // visible says anything about the main thread.
    const lag = document.visibilityState === 'visible' ? Math.max(0, now - expected) : 0
    expected = now + TICK_MS
    let ev = 0
    let top = ''
    let topN = 0
    const rooms = client.getRooms()
    for (const room of rooms) {
      const n = room.getLiveTimeline().getEvents().length
      ev += n
      if (n > topN) { topN = n; top = `${room.name.slice(0, 24)}:${n}` }
    }
    const over = describe(document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2))
    rec.snaps.push({
      t: new Date(now).toISOString().slice(11, 19),
      lag,
      dom: document.getElementsByTagName('*').length,
      ev,
      top,
      rooms: rooms.length,
      vis: document.visibilityState[0],
      path: location.pathname.slice(0, 40),
      over,
    })
    if (rec.snaps.length > MAX_SNAPS) rec.snaps.splice(0, rec.snaps.length - MAX_SNAPS)
    save(rec)
  }
  setInterval(tick, TICK_MS)

  // Capture phase, so a handler that stops propagation can't hide the tap.
  document.addEventListener('pointerdown', (e) => {
    const target = e.target instanceof Element ? e.target : null
    rec.taps.push(`${new Date().toISOString().slice(11, 19)} ${describe(target)} @${Math.round(e.clientX)},${Math.round(e.clientY)}`)
    if (rec.taps.length > MAX_TAPS) rec.taps.splice(0, rec.taps.length - MAX_TAPS)
  }, true)
  window.addEventListener('pagehide', () => {
    rec.ended = new Date().toISOString()
    save(rec)
  })
}

function format(label: string, raw: string | null): string {
  if (!raw) return `${label}: none`
  try {
    const r = JSON.parse(raw) as Record_
    const lines = [
      `${label}: v${r.version} started ${r.started}${r.ended ? ` ended ${r.ended}` : ' (no clean exit)'}`,
      'time     lag   dom  events rooms vis path | top room | over',
      ...r.snaps.map((s) => `${s.t} ${String(s.lag).padStart(5)} ${String(s.dom).padStart(5)} ${String(s.ev).padStart(6)} ${String(s.rooms).padStart(5)} ${s.vis} ${s.path} | ${s.top} | ${s.over}`),
      'taps:',
      ...r.taps.map((t) => `  ${t}`),
    ]
    return lines.join('\n')
  } catch {
    return `${label}: unreadable`
  }
}

/** Both sessions' records as text, for the Settings copy button. */
export function getHangReport(): string {
  try {
    return [format('previous session', localStorage.getItem(PREV_KEY)), format('this session', localStorage.getItem(KEY))].join('\n\n')
  } catch {
    return 'hang recorder: storage unavailable'
  }
}
