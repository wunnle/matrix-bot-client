import { useState, useEffect, useRef } from 'react'
import { getClient } from '../lib/matrix'
import { loadPills, savePills } from '../lib/roomMeta'

interface Props {
  roomId: string
  onClose: () => void
  onLeave: () => void
}

export default function RoomEditor({ roomId, onClose, onLeave }: Props) {
  const client = getClient()
  const [pills, setPills] = useState<string[]>([])
  const [newPill, setNewPill] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadPills(client, roomId).then(setPills)
  }, [client, roomId])

  function addPill() {
    const val = newPill.trim()
    if (!val || pills.includes(val)) return
    setPills((p) => [...p, val])
    setNewPill('')
    inputRef.current?.focus()
  }

  function removePill(pill: string) {
    setPills((p) => p.filter((x) => x !== pill))
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); addPill() }
  }

  async function resetEncryption() {
    if (!confirm('Force a fresh encryption session for this room? Useful when bot replies stop arriving after a bot restart.')) return
    try {
      await client.getCrypto()?.forceDiscardSession(roomId)
      alert('Session discarded. Send a message to trigger a fresh one.')
    } catch (e: any) {
      setError(e?.message ?? 'Failed to discard session')
    }
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      await savePills(client, roomId, pills)
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="room-editor-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="room-editor">
        <div className="room-editor-header">
          <span className="room-editor-title">Room settings</span>
          <button className="room-editor-close" onClick={onClose}>✕</button>
        </div>

        <div className="room-editor-body">
          <div className="editor-section-label">Quick-reply pills</div>

          <div className="editor-pills">
            {pills.map((pill) => (
              <span key={pill} className="editor-pill">
                {pill}
                <button onClick={() => removePill(pill)}>✕</button>
              </span>
            ))}
            {pills.length === 0 && <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>No pills yet</span>}
          </div>

          <div className="editor-pill-input">
            <input
              ref={inputRef}
              type="text"
              value={newPill}
              onChange={(e) => setNewPill(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add pill…"
              enterKeyHint="done"
            />
            <button onClick={addPill} disabled={!newPill.trim()}>Add</button>
          </div>

          {error && <div className="editor-error">{error}</div>}

          <div className="editor-section-label" style={{ marginTop: 24 }}>Troubleshooting</div>
          <button className="editor-btn-cancel" onClick={resetEncryption} style={{ width: '100%' }}>
            Reset encryption session
          </button>

          <div className="editor-section-label" style={{ marginTop: 24 }}>Danger zone</div>
          <button
            className="editor-btn-danger"
            style={{ width: '100%' }}
            onClick={async () => {
              if (!confirm('Leave this room?')) return
              try {
                await getClient().leave(roomId)
                onLeave()
              } catch (e: any) {
                setError(e?.message ?? 'Failed to leave room')
              }
            }}
          >
            Leave room
          </button>
        </div>

        <div className="room-editor-footer">
          <button className="editor-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="editor-btn-save" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
