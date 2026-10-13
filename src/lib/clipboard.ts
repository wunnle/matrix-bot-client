import { copyTextNative } from './liveActivity'

/** Put text on the system clipboard.
 *
 *  On the Mac app (Designed for iPad) navigator.clipboard.writeText resolves
 *  without reaching the macOS pasteboard, so every Copy said "Copied" and
 *  pasted nothing; there it goes through UIPasteboard natively, which macOS
 *  shares with other apps. Elsewhere: the async API, then the execCommand
 *  fallback for contexts that lack it. */
export async function copyTextToClipboard(text: string): Promise<void> {
  // Synchronous on purpose: Safari only lets writeText through while the tap
  // that asked for it is still current, so nothing may be awaited before it.
  if (document.documentElement.classList.contains('mac-app')) {
    try {
      await copyTextNative(text)
      return
    } catch {
      // An installed app older than this web code has no copyText yet (the
      // app loads the deployed site); the browser path is the best left.
    }
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    /* try fallback */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', 'true')
    ta.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch {
    /* ignore */
  }
}
