import { useState } from 'react'
import LocationPicker from '../components/LocationPicker'
import { locationContent } from '../lib/location'

// Dev only (main.tsx mounts it for ?location-picker under `vite`): the picker on
// its own, no Matrix login, Send shows the event it would have sent.
export default function LocationPickerHarness() {
  const [open, setOpen] = useState(true)
  const [sent, setSent] = useState<Record<string, unknown> | null>(null)
  return (
    <div style={{ padding: 16, color: 'var(--text)' }}>
      <button type="button" onClick={() => setOpen(true)}>Open picker</button>
      {sent && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(sent, null, 2)}</pre>}
      {open && (
        <LocationPicker
          onClose={() => setOpen(false)}
          onSend={(loc, kind) => { setSent(locationContent(loc, kind)); setOpen(false) }}
        />
      )}
    </div>
  )
}
