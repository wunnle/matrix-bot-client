import { apiUrl } from './apiUrl'
import { intentCredential } from './matrix'

const SCRIPT_URL = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.core.js'

// A token minted locally by scripts/mapkit-token.mjs, for trying the picker
// before the endpoint is deployed. Leave unset in real builds.
const DEV_TOKEN = import.meta.env.VITE_MAPKIT_TOKEN as string | undefined

async function fetchToken(): Promise<string> {
  if (DEV_TOKEN) return DEV_TOKEN
  const secret = intentCredential()
  if (!secret) throw new Error('Not signed in')
  const r = await fetch(apiUrl('/api/mapkit-token'), { headers: { 'x-intent-secret': secret } })
  if (!r.ok) throw new Error(`Map token: ${r.status}`)
  return (await r.json()).token
}

let loading: Promise<typeof mapkit> | null = null

// MapKit JS, loaded on first use and initialised once. A failed load clears
// itself so the next open of the picker tries again.
export function loadMapkit(): Promise<typeof mapkit> {
  if (!loading) {
    loading = new Promise<typeof mapkit>((resolve, reject) => {
      // The core script pulls its libraries in afterwards; data-callback is
      // what fires once they're all there. onload alone is too early.
      const callback = '__constructMapkitReady'
      ;(window as unknown as Record<string, unknown>)[callback] = () => {
        mapkit.init({
          authorizationCallback: (done) => {
            fetchToken().then(done, (err) => console.warn('[mapkit] token', err))
          },
        })
        mapkit.addEventListener('error', (e) => console.warn('[mapkit]', e.status))
        resolve(mapkit)
      }
      const script = document.createElement('script')
      script.src = SCRIPT_URL
      script.crossOrigin = 'anonymous'
      script.dataset.libraries = 'map,annotations,services'
      script.dataset.callback = callback
      script.onerror = () => {
        script.remove()
        reject(new Error('Could not load Apple Maps.'))
      }
      document.head.appendChild(script)
    }).catch((err) => {
      loading = null
      throw err
    })
  }
  return loading
}
