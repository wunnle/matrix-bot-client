export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

/**
 * Whether a keydown is ⌘K (Ctrl+K off Apple). Follows the typed character, so
 * Dvorak's K works; falls back to the key's position for non-Latin layouts.
 * Handled in JS everywhere, the Mac app included: a Designed-for-iPad app gets
 * no key commands past the web view.
 */
export function isPaletteShortcut(e: KeyboardEvent): boolean {
  if (e.altKey || e.shiftKey || e.isComposing) return false
  if (!(e.metaKey || e.ctrlKey) || (e.metaKey && e.ctrlKey)) return false
  const k = e.key.toLowerCase()
  return k === 'k' || (!/^[a-z]$/.test(k) && e.code === 'KeyK')
}
