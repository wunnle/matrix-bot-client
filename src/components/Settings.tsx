import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AuthState } from '../types'
import { getCachedRooms, isInvite } from '../lib/matrix'
import { getDisabledShareRooms, setDisabledShareRooms } from '../lib/shareRooms'
import { donateShareTargets } from '../lib/liveActivity'

/**
 * Settings screen. Currently just the Share-sheet section: pick which rooms
 * appear as direct-share targets in the iOS share sheet. Selection is stored
 * per-device; toggling re-donates the enabled set immediately.
 */
export default function Settings({ auth }: { auth: AuthState }) {
  const navigate = useNavigate()
  // Pending invites can't be share targets — you haven't joined them yet.
  const rooms = useMemo(
    () => (getCachedRooms(auth.userId) ?? []).filter((r) => !isInvite(r)),
    [auth.userId],
  )
  const [disabled, setDisabled] = useState<Set<string>>(() => getDisabledShareRooms(auth.userId))

  function toggle(roomId: string) {
    const next = new Set(disabled)
    if (next.has(roomId)) next.delete(roomId)
    else next.add(roomId)
    setDisabled(next)
    setDisabledShareRooms(auth.userId, next)
    void donateShareTargets(
      rooms.filter(r => !next.has(r.roomId)).map(r => ({ roomId: r.roomId, name: r.name, avatarMxc: r.avatarMxc })),
      [...next],
    )
  }

  return (
    <div className="settings-screen">
      <header className="settings-header">
        <button className="settings-back" onClick={() => navigate(-1)} aria-label="Back">←</button>
        <h1 className="settings-title">Settings</h1>
      </header>

      <section className="settings-section">
        <h2 className="settings-section-title">Share sheet</h2>
        <p className="settings-section-hint">
          Rooms you enable here show up as direct-share targets in the iOS share sheet.
        </p>
        {rooms.length === 0 && <p className="settings-empty">No rooms yet.</p>}
        {rooms.map(room => (
          <label key={room.roomId} className="settings-row" onClick={e => e.stopPropagation()}>
            <span className="settings-row-label">{room.name}</span>
            <input
              type="checkbox"
              className="settings-row-toggle"
              checked={!disabled.has(room.roomId)}
              onChange={() => toggle(room.roomId)}
              aria-label={`Share to ${room.name}`}
            />
          </label>
        ))}
      </section>
    </div>
  )
}
