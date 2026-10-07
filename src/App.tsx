import { useCallback, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { loadAuth, clearAuth } from './lib/auth'
import { destroyAndWipeStores } from './lib/matrix'
import type { AuthState } from './types'
import LoginScreen from './components/LoginScreen'
import MicDemo from './components/MicDemo'
import RoomsLayout from './components/RoomsLayout'
import DebugOverlay from './components/DebugOverlay'
import { Keyboard } from '@capacitor/keyboard'
import { usePushNotifications } from './hooks/usePushNotifications'
import { saveIntentConfig, isMacApp, macZoom } from './lib/liveActivity'
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
      // The WebView's pageZoom (set natively on Mac) leaves dvh and the box
      // fixed elements size against at their unzoomed size, so the layout ran
      // 1.3× past the window both ways. innerWidth/innerHeight are zoom-aware;
      // index.css sizes from these instead (see .mac-app there).
      const setAppSize = () => {
        document.documentElement.style.setProperty('--app-width', `${window.innerWidth}px`)
        document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`)
      }
      setAppSize()
      window.addEventListener('resize', setAppSize)
      // ⌘+ / ⌘− / ⌘0 zoom like any Mac app. Handled here because the native
      // side never sees them: a Designed-for-iPad app gets no menu-bar items
      // or key commands past the web view. e.key is the character typed, so
      // this follows the keyboard layout.
      window.addEventListener('keydown', (e) => {
        if (!e.metaKey || e.ctrlKey || e.altKey) return
        const step = e.key === '+' || e.key === '=' ? 1 : e.key === '-' ? -1 : e.key === '0' ? 0 : null
        if (step === null) return
        e.preventDefault()
        void macZoom(step).then(setAppSize)
      })
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
      {/* One layout route for every tab: mounting the layout from separate
          <Route> elements remounted it on every list ↔ room (and now tab)
          transition, throwing away clientReady/visitedRooms and re-running
          mount effects. The layout reads the path itself to pick the tab. */}
      <Route element={auth ? <RoomsLayout auth={auth} onSignOut={handleSignOut} /> : <Navigate to="/" replace />}>
        <Route path="/rooms/:roomId?" />
        <Route path="/usage" />
        <Route path="/settings" />
      </Route>
      <Route path="/mic-demo" element={<MicDemo />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  )
}
