const DEBUG_KEY = 'construct:debug'

export function isDebugEnabled(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

export function toggleDebug() {
  try {
    localStorage.setItem(DEBUG_KEY, isDebugEnabled() ? '0' : '1')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('construct-debug'))
}
