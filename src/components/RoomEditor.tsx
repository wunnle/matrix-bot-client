import { useState, useEffect, useRef } from 'react'
import { getClient } from '../lib/matrix'
import { loadPills, savePills } from '../lib/roomMeta'

interface Props {
  roomId: string
  onClose: () => void
}

export default function RoomEditor({ roomId, onClose }: Props) {
  const client = getClient()
  const [pills, setPills] = useState<string[]>([])
  const [newPill, setNewPill] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadPills(client, roomId).then(setPills)
    inputRef.current?.focus()
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
