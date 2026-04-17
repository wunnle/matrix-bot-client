import { useState, useEffect } from 'react'
import { loadAuth, clearAuth } from './lib/auth'
import { destroyClient } from './lib/matrix'
import type { AuthState } from './types'
import LoginScreen from './components/LoginScreen'
import RoomList from './components/RoomList'
import ChatView from './components/ChatView'
import './App.css'

type View =
  | { screen: 'login' }
  | { screen: 'rooms' }
  | { screen: 'chat'; roomId: string; roomName: string }

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [view, setView] = useState<View>({ screen: 'login' })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const stored = loadAuth()
    if (stored) {
      setAuth(stored)
      setView({ screen: 'rooms' })
    }
    setReady(true)
  }, [])

  function handleLogin(a: AuthState) {
    setAuth(a)
    setView({ screen: 'rooms' })
  }

  function handleSignOut() {
    destroyClient()
    clearAuth()
    setAuth(null)
    setView({ screen: 'login' })
  }

  if (!ready) return null

  if (view.screen === 'login' || !auth) {
    return <LoginScreen onLogin={handleLogin} />
  }

  if (view.screen === 'rooms') {
    return (
      <RoomList
        auth={auth}
        onSelectRoom={(roomId, roomName) => setView({ screen: 'chat', roomId, roomName })}
        onSignOut={handleSignOut}
      />
    )
  }

  if (view.screen === 'chat') {
    return (
      <ChatView
        roomId={view.roomId}
        roomName={view.roomName}
        userId={auth.userId}
        onBack={() => setView({ screen: 'rooms' })}
      />
    )
  }

  return null
}
