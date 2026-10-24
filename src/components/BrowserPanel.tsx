import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { addressToUrl, checkFrameable, openOutside, reachOf } from '../lib/browser'

// How long a page may take before the bar offers to open it outside. A
// refused frame often looks like a page that never finishes.
const SLOW_MS = 10_000

type View = 'checking' | 'frame' | 'refused' | 'local' | 'insecure'

/**
 * The sidebar's Browser tab: an address bar and one page, framed. Back walks
 * the pages opened here (a cross-origin page's own links can't be followed),
 * and anything that can't be framed gets a button to open it outside instead.
 * `url` is the page to show; a new one, typed or sent by an agent, goes on top
 * of the history.
 */
export default function BrowserPanel({ url, onUrl }: {
  url: string | null
  onUrl: (url: string | null) => void
}) {
  const [history, setHistory] = useState<{ stack: string[]; at: number }>(() => ({ stack: url ? [url] : [], at: url ? 0 : -1 }))
  const current = history.stack[history.at] ?? null
  // A page arriving from outside (an agent's card, another room's memory).
  if (url && url !== current) {
    setHistory((h) => ({ stack: [...h.stack.slice(0, h.at + 1), url], at: h.at + 1 }))
  }

  // What's being typed; while not editing, the bar shows the page's address.
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  // Ordinary web pages are asked about first; the answer is kept by URL.
  const reach = current ? reachOf(current) : null
  const [refusal, setRefusal] = useState<{ url: string; refused: boolean } | null>(null)
  useEffect(() => {
    if (!current || reachOf(current) !== 'web') return
    let live = true
    // Unknown (the server couldn't reach it) is worth trying.
    void checkFrameable(current).then(({ frameable }) => {
      if (live) setRefusal({ url: current, refused: frameable === false })
    })
    return () => { live = false }
  }, [current])
  // localhost is the viewing device, which is right for a dev server on the
  // Mac itself; whether the browser lets an https app frame it varies, so it
  // is the user's call ("Try anyway"), remembered for that address only.
  const [triedLocal, setTriedLocal] = useState<string | null>(null)
  const view: View = reach === 'local' && triedLocal === current ? 'frame'
    : reach === 'local' || reach === 'insecure' ? reach
    : reach !== 'web' ? 'frame'
    : refusal?.url !== current ? 'checking'
    : refusal.refused ? 'refused' : 'frame'

  // Each load of a page, reloads included, has its own key; `loadedKey` and
  // `slowKey` say which load finished, or took too long.
  const [reloads, setReloads] = useState(0)
  const frameKey = `${current}#${reloads}`
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [slowKey, setSlowKey] = useState<string | null>(null)
  useEffect(() => {
    if (view !== 'frame' || loadedKey === frameKey) return
    const t = setTimeout(() => setSlowKey(frameKey), SLOW_MS)
    return () => clearTimeout(t)
  }, [view, loadedKey, frameKey])
  const slow = slowKey === frameKey && loadedKey !== frameKey

  const inputRef = useRef<HTMLInputElement>(null)
  const go = (e: React.FormEvent) => {
    e.preventDefault()
    const next = addressToUrl(draft)
    if (!next) return
    setEditing(false)
    inputRef.current?.blur()
    if (next === current) setReloads((n) => n + 1)
    else onUrl(next)
  }
  const back = () => {
    if (history.at < 1) return
    const prev = history.stack[history.at - 1]
    setHistory((h) => ({ ...h, at: h.at - 1 }))
    onUrl(prev)
  }

  const outside = current && (
    <button type="button" className="browser-outside" onClick={() => void openOutside(current)}>
      Open in browser<span className="material-icons" aria-hidden="true">open_in_new</span>
    </button>
  )

  return (
    <div className="artifact-view browser-view">
      <form className="browser-bar" onSubmit={go}>
        <button type="button" className="browser-bar-btn" aria-label="Back" disabled={history.at < 1} onClick={back}>
          <span className="material-icons">arrow_back</span>
        </button>
        <button type="button" className="browser-bar-btn" aria-label="Reload" disabled={!current} onClick={() => setReloads((n) => n + 1)}>
          <span className="material-icons">refresh</span>
        </button>
        <input
          ref={inputRef}
          className="browser-address"
          type="text"
          inputMode="url"
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Address"
          aria-label="Address"
          value={editing ? draft : (current ?? '').replace(/^https:\/\//, '')}
          onFocus={(e) => { setEditing(true); setDraft(current ?? ''); requestAnimationFrame(() => e.target.select()) }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" className="browser-bar-btn" aria-label="Open in browser" title="Open in browser" disabled={!current} onClick={() => current && void openOutside(current)}>
          <span className="material-icons">open_in_new</span>
        </button>
      </form>

      {!current ? (
        <div className="browser-note">
          <p>Open a page beside the chat: type an address above.</p>
          <p>Agents open pages here too, like a dev server or a deployed preview of what they're working on.</p>
        </div>
      ) : view === 'local' ? (
        <div className="browser-note">
          <p><strong>localhost is this device.</strong> Pages running on the Pi need its tailnet address; ask the agent to open it with <code>construct-preview</code>.</p>
          <p>If the page runs on this device, it may still show here.</p>
          <div className="browser-note-actions">
            <button type="button" className="browser-outside" onClick={() => setTriedLocal(current)}>Try anyway</button>
            {outside}
          </div>
        </div>
      ) : view === 'insecure' ? (
        <div className="browser-note">
          <p>This page is plain http, which can't be shown inside the app.</p>
          {outside}
        </div>
      ) : view === 'refused' ? (
        <div className="browser-note">
          <p><strong>{new URL(current).hostname}</strong> doesn't allow being shown inside other apps.</p>
          {outside}
        </div>
      ) : view === 'checking' ? (
        <div className="artifact-preview-loading" aria-label="Loading" />
      ) : (
        <>
          {slow && (
            <div className="browser-slow">
              <span>Still loading. Some sites don't allow being shown here.</span>
              {outside}
            </div>
          )}
          <iframe
            key={frameKey}
            className="artifact-frame"
            title={new URL(current).hostname}
            src={current}
            // Under the app's COEP (vercel.json), Chromium only frames another
            // site without credentials; Safari ignores this.
            {...{ credentialless: '' }}
            referrerPolicy="no-referrer"
            allow="clipboard-write; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
            onLoad={() => setLoadedKey(frameKey)}
          />
        </>
      )}
    </div>
  )
}
