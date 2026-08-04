import { useState, useEffect, useRef } from 'react'
import { getClient } from '../lib/matrix'
import { loadPills, savePills } from '../lib/roomMeta'
import { useToast } from '../hooks/useToast'

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
  const [notifPref, setNotifPref] = useState<'all' | 'mentions' | 'mute' | null>(null)
  const [inviteInput, setInviteInput] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteStatus, setInviteStatus] = useState('')
  const [name, setName] = useState(() => client.getRoom(roomId)?.name ?? '')
  const [renaming, setRenaming] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast, showToast } = useToast()

  useEffect(() => {
    loadPills(client, roomId).then(setPills)
  }, [client, roomId])

  useEffect(() => {
    async function loadPushRule() {
      try {
        const rule = await client.http.authedRequest(
          'GET' as any,
          `/pushrules/global/room/${encodeURIComponent(roomId)}`,
          undefined, undefined,
          { prefix: '/_matrix/client/v3' }
        )
        const actions: any[] = (rule as any)?.actions ?? []
        if (actions.length === 0 || actions.every((a: any) => a === 'dont_notify' || a?.set_tweak === 'highlight')) {
          setNotifPref('mute')
        } else {
          setNotifPref('all')
        }
      } catch {
        setNotifPref('mentions')
      }
    }
    loadPushRule()
  }, [client, roomId])

  async function renameRoom() {
    const wanted = name.trim()
    const current = client.getRoom(roomId)?.name ?? ''
    if (!wanted || wanted === current) return
    setRenaming(true)
    setError('')
    try {
      await client.setRoomName(roomId, wanted)
      showToast('Renamed')
    } catch (e) {
      setError((e as Error).message ?? 'Could not rename room')
      setName(current)
    } finally {
      setRenaming(false)
    }
  }

  async function changeNotifPref(value: 'all' | 'mentions' | 'mute') {
    const prev = notifPref
    setNotifPref(value)
    try {
      if (value === 'mentions') {
        await client.http.authedRequest(
          'DELETE' as any,
          `/pushrules/global/room/${encodeURIComponent(roomId)}`,
          undefined, undefined,
          { prefix: '/_matrix/client/v3' }
        )
      } else {
        const actions = value === 'all'
          ? ['notify', { set_tweak: 'sound', value: 'default' }]
          : ['dont_notify']
        await client.http.authedRequest(
          'PUT' as any,
          `/pushrules/global/room/${encodeURIComponent(roomId)}`,
          undefined,
          { actions },
          { prefix: '/_matrix/client/v3' }
        )
      }
    } catch (e: any) {
      setNotifPref(prev)
      setError(e?.message ?? 'Failed to update notification setting')
    }
  }

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

  async function inviteUser() {
    const userId = inviteInput.trim()
    if (!userId) return
    setInviting(true)
    setInviteStatus('')
    try {
      await client.invite(roomId, userId)
      setInviteStatus(`Invited ${userId}`)
      setInviteInput('')
    } catch (e: any) {
      setInviteStatus(e?.message ?? 'Invite failed')
    } finally {
      setInviting(false)
    }
  }

  async function resetEncryption() {
    if (!confirm('Force a fresh encryption session? Send a message after to trigger a new one.')) return
    try {
      await client.getCrypto()?.forceDiscardSession(roomId)
      showToast('Session reset')
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
        {toast && <div className="toast">{toast}</div>}
        <div className="room-editor-header">
          <span className="room-editor-title">Room settings</span>
          <div className="room-editor-header-actions">
            <button
              className="room-editor-copy-id"
              onClick={() => { navigator.clipboard.writeText(roomId); showToast('Copied') }}
              title={roomId}
            >
              <span className="material-icons">tag</span>
            </button>
            <button className="room-editor-close" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="room-editor-body">

          <div className="editor-section">
            <div className="editor-section-label">Room name</div>
            <div className="editor-pill-input">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); renameRoom() } }}
                onBlur={renameRoom}
                placeholder="Room name"
                enterKeyHint="done"
              />
              <button
                onClick={renameRoom}
                disabled={renaming || !name.trim() || name.trim() === (client.getRoom(roomId)?.name ?? '')}
              >
                {renaming ? '…' : 'Save'}
              </button>
            </div>
          </div>

          <div className="editor-section">
            <div className="editor-section-label">Notification preference</div>
            <select
              value={notifPref ?? ''}
              disabled={notifPref === null}
              onChange={(e) => changeNotifPref(e.target.value as any)}
              className="editor-select"
            >
              {notifPref === null && <option value="">Loading…</option>}
              <option value="all">All messages</option>
              <option value="mentions">Mentions &amp; keywords</option>
              <option value="mute">Muted</option>
            </select>
          </div>

          <div className="editor-section">
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
          </div>

          <div className="editor-section">
            <div className="editor-section-label">Invite user</div>
            <div className="editor-pill-input">
              <input
                type="text"
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); inviteUser() } }}
                placeholder="@user:server.org"
                enterKeyHint="done"
              />
              <button onClick={inviteUser} disabled={inviting || !inviteInput.trim()}>
                {inviting ? '…' : 'Invite'}
              </button>
            </div>
            {inviteStatus && (
              <div style={{ fontSize: 12, marginTop: 4, color: inviteStatus.startsWith('Invited') ? 'var(--text-faint)' : 'var(--color-danger)' }}>
                {inviteStatus}
              </div>
            )}
          </div>

          {error && <div className="editor-error" style={{ paddingTop: 4 }}>{error}</div>}

          <div className="editor-section editor-actions-row">
            <button className="editor-btn-cancel editor-btn-inline" onClick={resetEncryption}>
              Reset session
            </button>
            <button
              className="editor-btn-danger editor-btn-inline"
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
