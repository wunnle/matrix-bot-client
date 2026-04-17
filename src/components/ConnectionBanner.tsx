import { useSyncState } from '../hooks/useSyncState'

export default function ConnectionBanner() {
  const state = useSyncState()

  if (state === 'SYNCING') return null

  const config = {
    CONNECTING: { label: 'Connecting…', className: 'banner-connecting' },
    RECONNECTING: { label: 'Reconnecting…', className: 'banner-reconnecting' },
    ERROR: { label: 'Connection lost', className: 'banner-error' },
  }[state]

  return (
    <div className={`connection-banner ${config.className}`}>
      <span className="banner-dot" />
      {config.label}
    </div>
  )
}
