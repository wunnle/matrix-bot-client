// Short server names ("bender") remembered per device. The real addresses
// live only in this device's localStorage, never in the (public) bundle.
const SERVERS_KEY = 'matrix_servers'

export const DEFAULT_SERVER = 'bender'

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SERVERS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

/** Short name for a server URL: the first label of its host name. */
export function serverName(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0]
  } catch {
    return url
  }
}

export function rememberServer(url: string): void {
  const name = serverName(url)
  const servers = load()
  if (servers[name] === url) return
  servers[name] = url
  try {
    localStorage.setItem(SERVERS_KEY, JSON.stringify(servers))
  } catch {
    /* storage full or blocked: the name just won't be remembered */
  }
}

/** Turn what was typed in the server box into a base URL. */
export function resolveServer(input: string): string {
  const value = input.trim().replace(/\/$/, '')
  const known = load()[value.toLowerCase()]
  if (known) return known
  if (value.includes('://')) return value
  if (value.includes('.')) return `https://${value}`
  throw new Error(`This device doesn't know "${value}" yet. Enter its full address once.`)
}
