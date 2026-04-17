import { useState, useEffect } from 'react'
import { loadAuth, clearAuth } from './lib/auth'
import { AuthState } from './types'
import LoginScreen from './components/LoginScreen'
import './App.css'

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const stored = loadAuth()
    if (stored) setAuth(stored)
    setReady(true)
  }, [])

  if (!ready) return null

  if (!auth) {
    return <LoginScreen onLogin={setAuth} />
  }

  return (
    <div className="app">
      <p>Logged in as {auth.userId}</p>
      <button onClick={() => { clearAuth(); setAuth(null) }}>Sign out</button>
    </div>
  )
}
