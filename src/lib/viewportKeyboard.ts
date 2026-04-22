/**
 * Reduce layout shift when the on-screen keyboard opens.
 * - Android Chrome: viewport meta `interactive-widget=overlays-content` (see index.html)
 *   and VirtualKeyboard.overlaysContent when available.
 * - iOS / others: keep shell height in sync with the largest inner height seen
 *   (keyboard shrinks innerHeight) so the flex column does not jump in height.
 */
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

  if (!window.matchMedia('(max-width: 640px)').matches) return

  const root = document.documentElement
  let maxInner = 0

  const sync = () => {
    const h = window.innerHeight
    if (h > maxInner) {
      maxInner = h
      root.style.setProperty('--app-locked-h', `${h}px`)
    }
  }

  sync()
  window.addEventListener('resize', sync, { passive: true })
  window.addEventListener('orientationchange', () => {
    maxInner = 0
    window.setTimeout(sync, 400)
  })
}
