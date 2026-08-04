import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import './index.css'
import App from './App.tsx'

if (Capacitor.isNativePlatform()) {
  Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {})
}

// Register up front rather than only when web push is enabled: the worker also
// caches the app shell, which is what lets a remote-loading native build (and
// the PWA) still open without connectivity. Fails harmlessly on origins where
// service workers aren't available, e.g. a bundled capacitor:// build.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
