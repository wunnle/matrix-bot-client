import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'

export type SyncState = 'CONNECTED' | 'RECONNECTING' | 'ERROR'

export function useSyncState(): SyncState | null {
  // null = no banner (initial connect or fully connected)
  const [state, setState] = useState<SyncState | null>(null)

  useEffect(() => {
    let client: sdk.MatrixClient
    try { client = getClient() } catch { return }

    let everConnected = false

    const onSync = (syncState: string) => {
      if (syncState === 'PREPARED' || syncState === 'SYNCING') {
        everConnected = true
        setState(null) // connected — hide banner
      } else if (syncState === 'RECONNECTING' || syncState === 'CATCHUP') {
        if (everConnected) setState('RECONNECTING')
      } else if (syncState === 'ERROR' || syncState === 'STOPPED') {
        if (everConnected) setState('ERROR')
      }
    }

    client.on(sdk.ClientEvent.Sync, onSync)
    return () => { client.off(sdk.ClientEvent.Sync, onSync) }
  }, [])

  return state
}
