import { useRef } from 'react'
import type React from 'react'
import { Capacitor } from '@capacitor/core'

// Same gate as ChatView's swipe-back: a regular browser already has an
// edge-swipe-back whose animation fights ours, so only the native app and an
// installed PWA — which have none — get one.
const enabled =
  typeof window !== 'undefined' &&
  (Capacitor.isNativePlatform() ||
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true)

/**
 * Right swipe from the left edge calls `onBack`, for full-page screens that
 * sit outside the chat layout. Spread the result onto the screen's root.
 */
export function useSwipeBack(onBack: () => void): Pick<React.HTMLAttributes<HTMLElement>, 'onTouchStart' | 'onTouchEnd'> {
  const start = useRef<{ x: number, y: number } | null>(null)
  if (!enabled) return {}
  return {
    onTouchStart: (e) => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } },
    onTouchEnd: (e) => {
      const s = start.current
      start.current = null
      if (!s) return
      const dx = e.changedTouches[0].clientX - s.x
      const dy = Math.abs(e.changedTouches[0].clientY - s.y)
      // Started within 40px of the edge, travelled 60px right, mostly level.
      if (s.x < 40 && dx > 60 && dy < 80) onBack()
    },
  }
}
