import { useState } from 'react'
import type { AgentProvider } from '../lib/spawnCommand'

/**
 * "What do you want to do?" before a new agent room is spawned. The answer
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

  return (
    <div className="room-editor-overlay" onClick={onClose}>
      <div className="room-editor spawn-sheet" role="dialog" aria-label={`New ${label} room`} onClick={(e) => e.stopPropagation()}>
        <div className="room-editor-header">
          <span className="room-editor-title">New {label} room</span>
          <button type="button" className="room-editor-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="room-editor-body spawn-sheet-body">
          <label className="spawn-sheet-label" htmlFor="spawn-prompt">What do you want to do?</label>
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
            rows={4}
            autoFocus
          />
          <p className="spawn-sheet-hint">The room is named after this and the agent starts on it right away.</p>
          <div className="spawn-sheet-actions">
            <button type="button" className="spawn-sheet-skip" onClick={() => onStart(null)}>Just open a room</button>
            <button type="button" className="spawn-sheet-start" disabled={!trimmed} onClick={start}>Start</button>
          </div>
        </div>
      </div>
    </div>
  )
}
