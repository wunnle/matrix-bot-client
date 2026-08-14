import { useAppVersion } from '../hooks/useAppVersion'

export default function UpdateBanner() {
  const { updateAvailable, reload } = useAppVersion()
  if (!updateAvailable) return null

  return (
    <div className="connection-banner banner-update">
      <span className="banner-dot" />
      New version available
      <button className="banner-action" onClick={reload}>
        Refresh
      </button>
    </div>
  )
}
