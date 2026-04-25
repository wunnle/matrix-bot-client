/**
 * True when the page runs in the Safari app on iPhone, iPad, or iPadOS
 * (including “desktop” iPad with MacIntel UA). Excludes other iOS browsers
 * (e.g. Chrome, Firefox) which identify as CriOS / FxiOS / EdgiOS / OPiOS.
 */
export function isMobileSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const isAppleTouch =
    /iPhone|iPod/.test(ua) ||
    /\biPad\b/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (!isAppleTouch) return false
  if (/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\//.test(ua)) return false
  return /Safari\//.test(ua)
}
