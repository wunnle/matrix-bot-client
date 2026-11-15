// Short server names ("bender") remembered per device in localStorage.
// The default server is built in, so a new device can sign in to it without
// typing an address. It is reachable only on the tailnet, so having it in the
// public bundle is fine.
const SERVERS_KEY = 'matrix_servers'

export const DEFAULT_SERVER = 'bender'
const BUILT_IN: Record<string, string> = {
  [DEFAULT_SERVER]: 'https://bender.tale-bellatrix.ts.net:6443',
}

function stored(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SERVERS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function load(): Record<string, string> {
  return { ...BUILT_IN, ...stored() }
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
  if (load()[name] === url) return
  const servers = stored()
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
