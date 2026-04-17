import { useSyncState } from '../hooks/useSyncState'

const BANNER_CONFIG = {
  CONNECTED: null,
  RECONNECTING: { label: 'Reconnecting…', className: 'banner-reconnecting' },
  ERROR: { label: 'Connection lost', className: 'banner-error' },
}

export default function ConnectionBanner() {
  const state = useSyncState()
  if (!state) return null

  const config = BANNER_CONFIG[state]
  if (!config) return null

  return (
    <div className={`connection-banner ${config.className}`}>
      <span className="banner-dot" />
      {config.label}
    </div>
  )
}
