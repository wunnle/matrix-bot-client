import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentProvider } from '../lib/spawnCommand'
import { sheetHost } from '../lib/roomView'

const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

/**
 * "What are we building?" before a new agent room is spawned. The answer
 * names the room (the bot asks Haiku for a short title) and is sent into it as
 * your first message once it opens, so the agent starts on it straight away.
 * Skipping it spawns a room the old way, named BenderDev-N until renamed.
 */
export default function SpawnSheet({ provider, onStart, onClose }: {
  provider: AgentProvider
  /** `prompt` is null when skipped. */
  onStart: (prompt: string | null) => void
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState('')
  const label = provider === 'codex' ? 'Codex' : 'Claude Code'
  const trimmed = prompt.trim()
  const start = () => { if (trimmed) onStart(trimmed) }

  // Portalled so it sits over the tab bar too (into #root, not <body>: see sheetHost).
  return createPortal(
    <div
      className="room-editor-overlay spawn-sheet-overlay"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className="room-editor spawn-sheet" role="dialog" aria-labelledby="spawn-prompt-title" onClick={(e) => e.stopPropagation()}>
        <div className="spawn-sheet-top">
          <span className="spawn-sheet-eyebrow">New {label} room</span>
          <button type="button" className="spawn-sheet-close" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <label id="spawn-prompt-title" className="spawn-sheet-title" htmlFor="spawn-prompt">What are we building?</label>
        {/* A composer, not a form: the send button lives inside the field. */}
        <div className="spawn-sheet-composer">
          <textarea
            id="spawn-prompt"
            className="spawn-sheet-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Enter is a new line, as in the composer on a phone; ⌘/Ctrl+Enter starts.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start() }
            }}
            placeholder="Fix the calendar gap in the morning digest"
            rows={3}
            autoFocus
          />
          <div className="spawn-sheet-composer-bar">
            <span className="spawn-sheet-keys" aria-hidden="true"><kbd>{MOD_KEY}</kbd><kbd>↵</kbd></span>
            <button type="button" className="spawn-sheet-start" disabled={!trimmed} onClick={start}>
              Start
              <span className="material-symbols-outlined">arrow_forward</span>
            </button>
          </div>
        </div>
        <button type="button" className="spawn-sheet-skip" onClick={() => onStart(null)}>or just open an empty room</button>
      </div>
    </div>,
    sheetHost(),
  )
}
