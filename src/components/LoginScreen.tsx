import { useState } from 'react'
import { matrixLogin, saveAuth } from '../lib/auth'
import { AuthState } from '../types'

interface Props {
  onLogin: (auth: AuthState) => void
}

export default function LoginScreen({ onLogin }: Props) {
  const [homeserver, setHomeserver] = useState('https://matrix.org')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const auth = await matrixLogin(homeserver, username, password)
      saveAuth(auth)
      onLogin(auth)
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      <h1>Matrix Bot Client</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Homeserver
          <input
            type="url"
            value={homeserver}
            onChange={e => setHomeserver(e.target.value)}
            required
          />
        </label>
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="@you:matrix.org"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
