import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

/** Minimal typing — global `SpeechRecognition` is not in all TS lib.dom versions. */
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

function useStandalonePwa() {
  const [standalone, setStandalone] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    const sync = () => {
      const ios = (window.navigator as { standalone?: boolean }).standalone === true
      setStandalone(mq.matches || ios)
    }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return standalone
}

export default function MicDemo() {
  const standalonePwa = useStandalonePwa()
  const [error, setError] = useState<string | null>(null)
  const [sttError, setSttError] = useState<string | null>(null)
  const [active, setActive] = useState(false)
  const [sttActive, setSttActive] = useState(false)
  const [level, setLevel] = useState(0)
  const [sttFinal, setSttFinal] = useState('')
  const [sttInterim, setSttInterim] = useState('')

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef(0)
  const runningRef = useRef(false)
  const recRef = useRef<WebSpeechRecognition | null>(null)

  const stopSpeech = useCallback(() => {
    const r = recRef.current
    recRef.current = null
    if (!r) {
      setSttActive(false)
      return
    }
    if (/\bApple\b/.test(navigator.vendor)) {
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
    setSttActive(false)
    setSttInterim('')
  }, [])

  const stop = useCallback(() => {
    stopSpeech()
    runningRef.current = false
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void ctxRef.current?.close()
    ctxRef.current = null
    setActive(false)
    setLevel(0)
  }, [stopSpeech])

  useEffect(() => () => stop(), [stop])

  function startSpeechToText() {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      setSttError('Web Speech API (SpeechRecognition) is not available in this browser.')
      return
    }
    if (!window.isSecureContext) {
      setSttError('Speech recognition needs HTTPS or localhost (secure context).')
      return
    }
    setSttError(null)
    setError(null)
    if (sttActive) return
    stop()
    setSttFinal('')
    setSttInterim('')

    const rec = new Ctor()
    recRef.current = rec
    rec.lang = navigator.language || 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (event: WebSttEvent) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i]![0]!.transcript
        if (event.results[i]!.isFinal) {
          setSttFinal((f) => f + piece)
        } else {
          interim += piece
        }
      }
      setSttInterim(interim)
    }
    rec.onerror = (e: WebSttError) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return
      setSttError(e.message || e.error)
    }
    rec.onend = () => {
      if (recRef.current === rec) {
        setSttActive(false)
        setSttInterim('')
        recRef.current = null
      }
    }
    try {
      rec.start()
      setSttActive(true)
    } catch (e) {
      setSttError(e instanceof Error ? e.message : String(e))
      recRef.current = null
    }
  }

  function stopStt() {
    setSttError(null)
    stopSpeech()
  }

  async function start() {
    if (!window.isSecureContext) {
      setError('Microphone needs HTTPS or localhost (secure context).')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('getUserMedia is not available in this context.')
      return
    }
    setError(null)
    if (sttActive) stopSpeech()
    if (active) {
      runningRef.current = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      void ctxRef.current?.close()
      ctxRef.current = null
      setLevel(0)
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const ctx = new AudioContext()
      await ctx.resume()
      ctxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      runningRef.current = true
      setActive(true)
      const tick = () => {
        if (!runningRef.current) return
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        setLevel(Math.min(1, rms * 2.5))
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const secure = typeof window !== 'undefined' && window.isSecureContext
  const sttAvailable = getSpeechRecognitionCtor() !== null

  return (
    <div className="mic-demo">
      <div className="mic-demo-card">
        <h1 className="mic-demo-title">Mic demo</h1>
        <p className="mic-demo-meta">
          {standalonePwa ? 'Running as installed PWA (standalone)' : 'Running in a browser tab'}
        </p>
        <p className="mic-demo-meta">
          Secure context: {secure ? 'yes' : 'no'}
        </p>

        <h2 className="mic-demo-section">Speech to text (Web Speech API)</h2>
        <p className="mic-demo-meta">
          {sttAvailable
            ? 'Uses the browser’s SpeechRecognition (e.g. webkit on Safari).'
            : 'Not available in this browser (e.g. Firefox has no Web Speech in most builds).'}
        </p>
        <div className="mic-demo-transcript" aria-live="polite">
          {sttFinal}
          {sttInterim ? <span className="mic-demo-transcript-interim">{sttInterim}</span> : null}
          {!sttFinal && !sttInterim && !sttActive && sttAvailable ? (
            <span className="mic-demo-transcript-empty">Transcript will appear here.</span>
          ) : null}
        </div>
        {sttError && <p className="mic-demo-error" role="alert">{sttError}</p>}
        <div className="mic-demo-actions">
          <button
            type="button"
            className="mic-demo-btn mic-demo-btn-primary"
            onClick={startSpeechToText}
            disabled={!sttAvailable || sttActive}
          >
            Start dictation
          </button>
          <button
            type="button"
            className="mic-demo-btn"
            onClick={stopStt}
            disabled={!sttActive}
          >
            Stop dictation
          </button>
        </div>

        <h2 className="mic-demo-section">Raw mic level (getUserMedia)</h2>
        <p className="mic-demo-hint">
          {active ? 'Speak — the bar should move. Tap Stop when done.' : 'Stops dictation if it was running, then uses the raw mic for the meter.'}
        </p>
        <div className="mic-demo-meter" aria-hidden>
          <div className="mic-demo-meter-fill" style={{ transform: `scaleX(${active ? level : 0})` }} />
        </div>
        {error && <p className="mic-demo-error" role="alert">{error}</p>}
        <div className="mic-demo-actions">
          <button
            type="button"
            className="mic-demo-btn mic-demo-btn-primary"
            onClick={start}
            disabled={active}
          >
            Start
          </button>
          <button
            type="button"
            className="mic-demo-btn"
            onClick={stop}
            disabled={!active}
          >
            Stop
          </button>
        </div>
        <Link to="/" className="mic-demo-back">
          ← Back
        </Link>
      </div>
    </div>
  )
}
