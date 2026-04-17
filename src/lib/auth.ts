import type { AuthState } from '../types'

const AUTH_KEY = 'matrix_auth'

export function saveAuth(auth: AuthState): void {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth))
}

export function loadAuth(): AuthState | null {
  const raw = localStorage.getItem(AUTH_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY)
}

export async function matrixLogin(
  homeserver: string,
  username: string,
  password: string
): Promise<AuthState> {
  const base = homeserver.replace(/\/$/, '')
  const res = await fetch(`${base}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Login failed: ${res.status}`)
  }

  const data = await res.json()
  return {
    accessToken: data.access_token,
    userId: data.user_id,
    deviceId: data.device_id,
    homeserver: base,
  }
}
