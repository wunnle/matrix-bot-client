import { useState, useEffect } from 'react'
import { loadAuth, clearAuth } from './lib/auth'
import { destroyClient } from './lib/matrix'
import type { AuthState } from './types'
import LoginScreen from './components/LoginScreen'
import RoomList from './components/RoomList'
import ChatView from './components/ChatView'
import ConnectionBanner from './components/ConnectionBanner'
import './App.css'

interface ActiveRoom {
  roomId: string
  roomName: string
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [ready, setReady] = useState(false)
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null)

  useEffect(() => {
    const stored = loadAuth()
    if (stored) setAuth(stored)
    setReady(true)
  }, [])

  function handleLogin(a: AuthState) {
    setAuth(a)
  }

  function handleSignOut() {
    destroyClient()
    clearAuth()
    setAuth(null)
    setActiveRoom(null)
  }

  if (!ready) return null

  if (!auth) {
    return <LoginScreen onLogin={handleLogin} />
  }

  return (
    <div className={`layout ${activeRoom ? 'room-open' : ''}`}>
      <ConnectionBanner />
      <div className="layout-body">
        <aside className="sidebar">
          <RoomList
            auth={auth}
            activeRoomId={activeRoom?.roomId ?? null}
            onSelectRoom={(roomId, roomName) => setActiveRoom({ roomId, roomName })}
            onSignOut={handleSignOut}
          />
        </aside>

        <main className="main">
          {activeRoom ? (
            <ChatView
              roomId={activeRoom.roomId}
              roomName={activeRoom.roomName}
              userId={auth.userId}
              onBack={() => setActiveRoom(null)}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-icon">💬</div>
              <p>Select a room to start chatting</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
