import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { loadAuth, clearAuth } from './lib/auth'
import { destroyAndWipeStores } from './lib/matrix'
import type { AuthState } from './types'
import LoginScreen from './components/LoginScreen'
import MicDemo from './components/MicDemo'
import RoomsLayout from './components/RoomsLayout'
import { usePushNotifications } from './hooks/usePushNotifications'
import './App.css'

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [ready, setReady] = useState(false)
  const [debugLog, setDebugLog] = useState<string[]>([])
  const navigate = useNavigate()

  usePushNotifications(!!auth)

  const log = (msg: string) => {
    const ts = new Date().toLocaleTimeString()
    setDebugLog(prev => [`${ts} ${msg}`, ...prev].slice(0, 20))
  }

  useEffect(() => {
    const stored = loadAuth()
    if (stored) setAuth(stored)
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready) return

    function handleDeepLink(trigger: string) {
      const href = window.location.href
      const params = new URLSearchParams(window.location.search)
      const path = params.get('path')
      log(`${trigger} href=${href}`)
      if (path) {
        log(`→ navigating to path param: ${path}`)
        navigate(path, { replace: true })
        return
      }
      const pathname = window.location.pathname
      if (pathname && pathname !== '/' && pathname !== '/rooms') {
        log(`→ navigating to pathname: ${pathname}`)
        navigate(pathname, { replace: true })
      } else {
        log(`→ no navigation (pathname=${pathname})`)
      }
    }

    handleDeepLink('mount')

    const onFocus = () => handleDeepLink('focus')
    const onVisible = () => { if (document.visibilityState === 'visible') handleDeepLink('visibilitychange') }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ready])

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
    {debugLog.length > 0 && (
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999, background: 'rgba(0,0,0,0.85)', color: '#0f0', fontFamily: 'monospace', fontSize: 11, padding: '6px 10px', maxHeight: 180, overflowY: 'auto' }} onClick={() => setDebugLog([])}>
        {debugLog.map((l, i) => <div key={i}>{l}</div>)}
        <div style={{ color: '#666', marginTop: 4 }}>tap to dismiss</div>
      </div>
    )}
    <Routes>
      <Route
        path="/"
        element={auth ? <Navigate to="/rooms" replace /> : <LoginScreen onLogin={handleLogin} />}
      />
      <Route
        path="/rooms"
        element={auth ? <RoomsLayout auth={auth} onSignOut={handleSignOut} /> : <Navigate to="/" replace />}
      />
      <Route
        path="/rooms/:roomId"
        element={auth ? <RoomsLayout auth={auth} onSignOut={handleSignOut} /> : <Navigate to="/" replace />}
      />
      <Route path="/mic-demo" element={<MicDemo />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  )
}
