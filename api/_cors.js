/**
 * CORS for the intent endpoints, shared so every one of them agrees on who may
 * call from a browser context.
 *
 * Two origins run Construct's client: the web app itself, and the native iOS
 * app, whose bundled WebView loads from capacitor://localhost. The native app
 * has to call these endpoints cross-origin — a relative /api/... resolves
 * against its own bundle and goes nowhere — and every call carries
 * x-intent-secret, so each one is preflighted.
 *
 * Bots, Shortcuts and the native Swift code send no Origin at all; nothing here
 * changes for them. CORS is not the access control — authorized() is.
 */
const ALLOWED_ORIGINS = new Set([
  'https://construct.kafagoz.com',
  'capacitor://localhost',
])

/**
 * Sets the CORS headers and answers the preflight. Returns true when the
 * request was a preflight and has been handled — the caller must return then,
 * *before* checking auth: a preflight never carries the credential, so
 * authorizing it first rejected every cross-origin call.
 */
export function cors(req, res) {
  const origin = req.headers?.origin
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-intent-secret')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }
  return false
}
