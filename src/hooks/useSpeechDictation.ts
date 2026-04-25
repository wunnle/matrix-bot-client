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
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
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
 * How long with no onresult/onspeechstart before we show "Silence". WebKit
 * often does not fire onspeechend under continuous mode; this debounce fixes that.
 */
const HEARING_QUIET_MS = 1200

/**
 * One-shot or continuous Web Speech → text, merged with a static prefix
 * (e.g. existing compose text when dictation started).
 */
export function useSpeechDictation(
  onText: (full: string) => void,
) {
  const [dictating, setDictating] = useState(false)
  /** True while the user is likely still talking (per activity debounce, not only Web Speech events). */
  const [userSpeaking, setUserSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<WebSpeechRecognition | null>(null)
  const prefixRef = useRef('')
  const finalsRef = useRef('')
  const lastActivityAtRef = useRef(0)
  const hearingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const endHearingWatch = useCallback(() => {
    if (hearingIntervalRef.current) {
      clearInterval(hearingIntervalRef.current)
      hearingIntervalRef.current = null
    }
    lastActivityAtRef.current = 0
    setUserSpeaking(false)
  }, [])

  const bumpSpeechActivity = useCallback(() => {
    lastActivityAtRef.current = Date.now()
    setUserSpeaking(true)
  }, [])

  const startHearingWatch = useCallback(() => {
    if (hearingIntervalRef.current) {
      clearInterval(hearingIntervalRef.current)
    }
    hearingIntervalRef.current = setInterval(() => {
      const t = lastActivityAtRef.current
      if (t === 0) return
      if (Date.now() - t >= HEARING_QUIET_MS) {
        lastActivityAtRef.current = 0
        setUserSpeaking(false)
      }
    }, 100)
  }, [])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const stop = useCallback(() => {
    const r = recRef.current
    recRef.current = null
    if (!r) {
      endHearingWatch()
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
    endHearingWatch()
    setDictating(false)
  }, [endHearingWatch])

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
        bumpSpeechActivity()
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
      rec.onspeechstart = () => {
        bumpSpeechActivity()
      }
      rec.onspeechend = () => {
        lastActivityAtRef.current = 0
        setUserSpeaking(false)
      }
      rec.onend = () => {
        if (recRef.current === rec) {
          endHearingWatch()
          setDictating(false)
          recRef.current = null
        }
      }
      try {
        rec.start()
        setUserSpeaking(false)
        setDictating(true)
        startHearingWatch()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        recRef.current = null
        endHearingWatch()
        setDictating(false)
      }
    },
    [onText, stop, endHearingWatch, bumpSpeechActivity, startHearingWatch],
  )

  useEffect(() => () => stop(), [stop])

  return {
    dictating,
    userSpeaking,
    start,
    stop,
    error,
    clearError,
    supported: getSpeechRecognitionCtor() !== null,
  }
}
