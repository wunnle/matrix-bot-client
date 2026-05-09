import { useState, useCallback } from 'react'

export function useToast() {
  const [toast, setToast] = useState<string | null>(null)

  const showToast = useCallback((msg: string, duration = 2000) => {
    setToast(msg)
    setTimeout(() => setToast(null), duration)
  }, [])

  return { toast, showToast }
}
