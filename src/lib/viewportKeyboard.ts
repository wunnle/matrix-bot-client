/**
 * Reduce layout shift when the on-screen keyboard opens.
 * - `interactive-widget=overlays-content` (index.html) + VirtualKeyboard when supported.
 * - `--app-locked-h` tracks the largest shell height seen; when the OSK shrinks
 *   innerHeight/visualViewport, we keep the shell tall so the flex column does
 *   not reflow. CSS (max-width: 640px) must use this var — a later `height: 100dvh`
 *   on `.layout` was overriding that and re-broke the layout.
 */
const MOBILE_MQ = '(max-width: 640px)'

function readShellHeight(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0
  const { innerHeight, visualViewport } = window
  const fromDoc = document.documentElement?.clientHeight ?? 0
  const fromVv = visualViewport?.height && visualViewport.height > 0 ? visualViewport.height : 0
  return Math.max(innerHeight, fromVv, fromDoc)
}

export function installKeyboardLayoutFix(): void {
  if (typeof window === 'undefined') return

  const nav = navigator as Navigator & { virtualKeyboard?: { overlaysContent: boolean } }
  if (nav.virtualKeyboard) {
    try {
      nav.virtualKeyboard.overlaysContent = true
    } catch {
      /* ignored */
    }
  }

  if (!window.matchMedia(MOBILE_MQ).matches) return

  const root = document.documentElement
  const parseLocked = () => {
    const v = getComputedStyle(root).getPropertyValue('--app-locked-h').trim()
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  // Start from inline script (or prior paint) so we never drop to a smaller innerHeight
  // on first run (e.g. module load after the keyboard is already up).
  let maxH = parseLocked()

  const sync = () => {
    const h = readShellHeight()
    if (h > maxH) {
      maxH = h
      root.style.setProperty('--app-locked-h', `${h}px`)
    }
  }

  sync()
  window.addEventListener('resize', sync, { passive: true })
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) sync()
  })

  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', sync, { passive: true })
    vv.addEventListener('scroll', sync, { passive: true })
  }

  window.addEventListener('orientationchange', () => {
    maxH = 0
    window.setTimeout(sync, 400)
  })
}
