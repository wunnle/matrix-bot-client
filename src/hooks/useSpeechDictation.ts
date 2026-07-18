import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'

// Native SFSpeechRecognizer bridge (SpeechRecognitionPlugin in
// AppDelegate.swift). transcript is cumulative for the session.
interface NativeSpeechPlugin {
  available(): Promise<{ available: boolean }>
  start(options?: { lang?: string }): Promise<void>
  stop(): Promise<void>
  addListener(event: 'result', cb: (e: { transcript: string; isFinal: boolean }) => void): Promise<PluginListenerHandle>
  addListener(event: 'end', cb: () => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

const nativeSpeech: NativeSpeechPlugin | null = Capacitor.isNativePlatform()
  ? registerPlugin<NativeSpeechPlugin>('SpeechRecognition')
  : null

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

export type DictationMode = 'off' | 'manual' | 'auto'

type HookOptions = {
  /** Fired in auto mode after long silence when there is text to send. */
  onAutoSend?: (text: string) => void
}

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
 * After this much quiet (since last onresult/onspeechstart), auto mode
 * will send the message and stop, if the field is non-empty and STT added content.
 */
const AUTO_SEND_SILENCE_MS = 2500

/**
 * One-shot or continuous Web Speech → text, merged with a static prefix
 * (e.g. existing compose text when dictation started).
 */
export function useSpeechDictation(
  onText: (full: string) => void,
  options?: HookOptions,
) {
  const [dictationMode, setDictationMode] = useState<DictationMode>('off')
  const [userSpeaking, setUserSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<WebSpeechRecognition | null>(null)
  const prefixRef = useRef('')
  const finalsRef = useRef('')
  /** Last onresult/onspeechstart; not cleared on "Silence" so long-silence auto-send can use it. */
  const lastActivityAtRef = useRef(0)
  const hearingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastHearingUIReturnedRef = useRef(false)
  const onAutoSendRef = useRef<((text: string) => void) | undefined>(undefined)
  const stopRef = useRef<() => void>(() => {})
  const autoModeRef = useRef(false)
  const hadSttThisSessionRef = useRef(false)
  const lastEmittedTextRef = useRef('')
  onAutoSendRef.current = options?.onAutoSend

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const endHearingWatch = useCallback(() => {
    if (hearingIntervalRef.current) {
      clearInterval(hearingIntervalRef.current)
      hearingIntervalRef.current = null
    }
    lastActivityAtRef.current = 0
    lastHearingUIReturnedRef.current = false
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
    lastHearingUIReturnedRef.current = false
    hearingIntervalRef.current = setInterval(() => {
      const t = lastActivityAtRef.current
      const now = Date.now()
      if (t > 0) {
        const shouldHear = now - t < HEARING_QUIET_MS
        if (shouldHear !== lastHearingUIReturnedRef.current) {
          lastHearingUIReturnedRef.current = shouldHear
          setUserSpeaking(shouldHear)
        }
        const isAuto = autoModeRef.current
        if (isAuto && now - t >= AUTO_SEND_SILENCE_MS) {
          if (hadSttThisSessionRef.current) {
            const text = lastEmittedTextRef.current
            const onAuto = onAutoSendRef.current
            if (text.trim() && onAuto) {
              onAuto(text)
            } else {
              stopRef.current()
            }
          } else {
            stopRef.current()
          }
        }
      }
    }, 100)
  }, [])

  const nativeActiveRef = useRef(false)

  const stop = useCallback(() => {
    setDictationMode('off')
    autoModeRef.current = false
    hadSttThisSessionRef.current = false
    if (nativeSpeech && nativeActiveRef.current) {
      nativeActiveRef.current = false
      nativeSpeech.stop().catch(() => {})
      nativeSpeech.removeAllListeners().catch(() => {})
      endHearingWatch()
      return
    }
    const r = recRef.current
    recRef.current = null
    if (!r) {
      endHearingWatch()
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
  }, [endHearingWatch])

  stopRef.current = stop

  type StartOptions = { autoSend?: boolean }
  const start = useCallback(
    (prefix: string, startOptions?: StartOptions) => {
      // Native path: SFSpeechRecognizer via the SpeechRecognition plugin.
      if (nativeSpeech) {
        setError(null)
        stop()
        const isAuto = !!startOptions?.autoSend
        autoModeRef.current = isAuto
        setDictationMode(isAuto ? 'auto' : 'manual')
        hadSttThisSessionRef.current = false
        lastEmittedTextRef.current = prefix
        prefixRef.current = prefix
        nativeActiveRef.current = true

        nativeSpeech.addListener('result', ({ transcript }) => {
          if (!nativeActiveRef.current) return
          hadSttThisSessionRef.current = true
          bumpSpeechActivity()
          const p = prefixRef.current
          const full = p + (p && !p.endsWith(' ') ? ' ' : '') + transcript
          lastEmittedTextRef.current = full
          onText(full)
        })
        nativeSpeech.addListener('end', () => {
          if (!nativeActiveRef.current) return
          nativeActiveRef.current = false
          nativeSpeech.removeAllListeners().catch(() => {})
          setDictationMode('off')
          autoModeRef.current = false
          hadSttThisSessionRef.current = false
          endHearingWatch()
        })
        nativeSpeech.start({ lang: typeof navigator !== 'undefined' ? navigator.language : undefined })
          .then(() => {
            lastHearingUIReturnedRef.current = false
            setUserSpeaking(false)
            startHearingWatch()
          })
          .catch((e) => {
            nativeActiveRef.current = false
            nativeSpeech.removeAllListeners().catch(() => {})
            setError(e instanceof Error ? e.message : String(e))
            setDictationMode('off')
            autoModeRef.current = false
            endHearingWatch()
          })
        return
      }

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
      const isAuto = !!startOptions?.autoSend
      autoModeRef.current = isAuto
      setDictationMode(isAuto ? 'auto' : 'manual')
      hadSttThisSessionRef.current = false
      lastEmittedTextRef.current = prefix
      prefixRef.current = prefix
      finalsRef.current = ''

      const rec = new Ctor()
      recRef.current = rec
      rec.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US'
      rec.continuous = true
      rec.interimResults = true
      rec.onresult = (event: WebSttEvent) => {
        hadSttThisSessionRef.current = true
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
        const full = prefixRef.current + finalsRef.current + interim
        lastEmittedTextRef.current = full
        onText(full)
      }
      rec.onerror = (e: WebSttError) => {
        if (e.error === 'aborted' || e.error === 'no-speech') return
        setError(e.message || e.error)
      }
      rec.onspeechstart = () => {
        bumpSpeechActivity()
      }
      rec.onend = () => {
        if (recRef.current === rec) {
          setDictationMode('off')
          autoModeRef.current = false
          hadSttThisSessionRef.current = false
          recRef.current = null
          endHearingWatch()
        }
      }
      try {
        rec.start()
        lastHearingUIReturnedRef.current = false
        setUserSpeaking(false)
        startHearingWatch()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        recRef.current = null
        setDictationMode('off')
        autoModeRef.current = false
        hadSttThisSessionRef.current = false
        endHearingWatch()
      }
    },
    [onText, stop, endHearingWatch, bumpSpeechActivity, startHearingWatch],
  )

  useEffect(() => () => stop(), [stop])

  const dictating = dictationMode !== 'off'

  return {
    dictating,
    dictationMode,
    userSpeaking,
    start,
    stop,
    error,
    clearError,
    supported: nativeSpeech !== null || getSpeechRecognitionCtor() !== null,
  }
}
