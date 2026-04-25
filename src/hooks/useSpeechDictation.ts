import { useCallback, useEffect, useRef, useState } from 'react'

type WebSttEvent = {
  resultIndex: number
  results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } }
}
type WebSttError = { error: string; message: string }
type WebSpeechRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: WebSttEvent) => void) | null
  onerror: ((e: WebSttError) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecCtor = new () => WebSpeechRecognition

function getSpeechRecognitionCtor(): SpeechRecCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecCtor
    webkitSpeechRecognition?: SpeechRecCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * One-shot or continuous Web Speech → text, merged with a static prefix
 * (e.g. existing compose text when dictation started).
 */
export function useSpeechDictation(
  onText: (full: string) => void,
) {
  const [dictating, setDictating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<WebSpeechRecognition | null>(null)
  const prefixRef = useRef('')
  const finalsRef = useRef('')

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const stop = useCallback(() => {
    const r = recRef.current
    recRef.current = null
    if (!r) {
      setDictating(false)
      return
    }
    if (typeof navigator !== 'undefined' && /\bApple\b/.test(navigator.vendor)) {
      try {
        r.start()
      } catch {
        /* already running */
      }
    }
    try {
      r.stop()
    } catch {
      /* */
    }
    try {
      r.abort()
    } catch {
      /* */
    }
    setDictating(false)
  }, [])

  const start = useCallback(
    (prefix: string) => {
      const Ctor = getSpeechRecognitionCtor()
      if (!Ctor) {
        setError('Speech recognition is not available in this context.')
        return
      }
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setError('Dictation needs HTTPS (or localhost).')
        return
      }
      setError(null)
      stop()
      prefixRef.current = prefix
      finalsRef.current = ''

      const rec = new Ctor()
      recRef.current = rec
      rec.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US'
      rec.continuous = true
      rec.interimResults = true
      rec.onresult = (event: WebSttEvent) => {
        let interim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i]![0]!.transcript
          if (event.results[i]!.isFinal) {
            finalsRef.current += piece
          } else {
            interim += piece
          }
        }
        onText(prefixRef.current + finalsRef.current + interim)
      }
      rec.onerror = (e: WebSttError) => {
        if (e.error === 'aborted' || e.error === 'no-speech') return
        setError(e.message || e.error)
      }
      rec.onend = () => {
        if (recRef.current === rec) {
          setDictating(false)
          recRef.current = null
        }
      }
      try {
        rec.start()
        setDictating(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        recRef.current = null
        setDictating(false)
      }
    },
    [onText, stop],
  )

  useEffect(() => () => stop(), [stop])

  return { dictating, start, stop, error, clearError, supported: getSpeechRecognitionCtor() !== null }
}
