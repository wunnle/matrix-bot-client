import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'

export type SyncState = 'CONNECTING' | 'SYNCING' | 'RECONNECTING' | 'ERROR'

function toSyncState(syncState: string, prevState: string | null): SyncState | null {
  if (syncState === 'PREPARED' || syncState === 'SYNCING') return 'SYNCING'
  if (syncState === 'RECONNECTING') return 'RECONNECTING'
  if (syncState === 'ERROR' || syncState === 'STOPPED') return 'ERROR'
  if (syncState === 'CATCHUP') return prevState === 'RECONNECTING' ? 'RECONNECTING' : 'SYNCING'
  return null
}

export function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>(() => {
    // Read current sync state on init — avoids missing PREPARED if already synced
    try {
      const client = getClient()
      const current = client.getSyncState()
      return toSyncState(current ?? '', null) ?? 'CONNECTING'
    } catch {
      return 'CONNECTING'
    }
  })

  useEffect(() => {
    let client: sdk.MatrixClient
    try { client = getClient() } catch { return }

    const onSync = (syncState: string, prevState: string | null) => {
      const next = toSyncState(syncState, prevState)
      if (next) setState(next)
    }

    client.on(sdk.ClientEvent.Sync, onSync)
    return () => { client.off(sdk.ClientEvent.Sync, onSync) }
  }, [])

  return state
}
