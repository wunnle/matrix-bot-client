import { useCallback, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { loadAuth, clearAuth } from './lib/auth'
import { destroyAndWipeStores } from './lib/matrix'
import type { AuthState } from './types'
import LoginScreen from './components/LoginScreen'
import MicDemo from './components/MicDemo'
import RoomsLayout from './components/RoomsLayout'
import Settings from './components/Settings'
import DebugOverlay from './components/DebugOverlay'
import { Keyboard } from '@capacitor/keyboard'
import { usePushNotifications } from './hooks/usePushNotifications'
import { saveIntentConfig, isMacApp } from './lib/liveActivity'
import './App.css'

// Default room the "Ask Construct" Shortcut targets (Bender).
const DEFAULT_INTENT_ROOM = '!DpRWqhWOHJAxyvjOGI:matrix.org'

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [ready, setReady] = useState(false)
  const navigate = useNavigate()

  const openNotificationRoom = useCallback((roomId: string) => {
    navigate(`/rooms/${encodeURIComponent(roomId)}`)
  }, [navigate])

  usePushNotifications(!!auth, openNotificationRoom)

  useEffect(() => {
    const stored = loadAuth()
    if (stored) setAuth(stored)
    setReady(true)
    void saveIntentConfig(DEFAULT_INTENT_ROOM)
    // Running as an iPad app on a Mac: scale the mobile-first UI up and stop the
    // phantom software keyboard's accessory bar from popping up over inputs.
    void isMacApp().then(mac => {
      if (!mac) return
      document.documentElement.classList.add('mac-app')
      Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {})
    })
  }, [])

  function handleLogin(a: AuthState) {
    setAuth(a)
    navigate('/rooms')
  }

  function handleSignOut() {
    const userId = auth?.userId ?? ''
    destroyAndWipeStores(userId).catch(() => {})
    clearAuth()
    setAuth(null)
    navigate('/')
  }

  if (!ready) return null

  return (
    <>
    <DebugOverlay />
    <Routes>
      <Route
        path="/"
        element={auth ? <Navigate to="/rooms" replace /> : <LoginScreen onLogin={handleLogin} />}
      />
      {/* One route, optional param: mounting the layout from two separate
          <Route> elements remounted it on every list ↔ room transition,
          throwing away clientReady/visitedRooms and re-running mount effects. */}
      <Route
        path="/rooms/:roomId?"
        element={auth ? <RoomsLayout auth={auth} onSignOut={handleSignOut} /> : <Navigate to="/" replace />}
      />
      <Route
        path="/settings"
        element={auth ? <Settings auth={auth} /> : <Navigate to="/" replace />}
      />
      <Route path="/mic-demo" element={<MicDemo />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  )
}
