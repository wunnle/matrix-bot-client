import { useCallback, useEffect, useState } from 'react'

const POLL_MS = 15 * 60 * 1000

/** Fetched, never cached — a cached answer would report the version we already run. */
async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

/**
 * Notices when the deployed build no longer matches the one in this tab.
 * The app shell is served network-first, so a plain reload is enough to pick
 * the new build up; the hashed assets it pulls in are new URLs. The shell
 * caches are dropped anyway so an offline start can't resurrect the old index.
 */
export function useAppVersion() {
  const [updateAvailable, setUpdateAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      const deployed = await fetchDeployedVersion()
      if (cancelled || !deployed) return
      if (deployed !== __CONSTRUCT_VERSION__) setUpdateAvailable(true)
    }

    check()
    const timer = setInterval(check, POLL_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  const reload = useCallback(async () => {
    try {
      const names = await caches.keys()
      await Promise.all(
        names.filter((n) => n.startsWith('construct-shell-')).map((n) => caches.delete(n))
      )
    } catch {
      // Cache API unavailable or blocked — the reload below still works.
    }
    try {
      const reg = await navigator.serviceWorker?.getRegistration()
      await reg?.update()
    } catch {
      // Ignore: an outdated worker still serves the app fine.
    }
    location.reload()
  }, [])

  return { updateAvailable, reload }
}
