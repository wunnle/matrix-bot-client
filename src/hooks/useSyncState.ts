import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { getClient } from '../lib/matrix'

export type SyncState = 'CONNECTING' | 'SYNCING' | 'RECONNECTING' | 'ERROR'

export function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>('CONNECTING')

  useEffect(() => {
    let client: sdk.MatrixClient
    try { client = getClient() } catch { return }

    const onSync = (syncState: string, prevState: string | null) => {
      if (syncState === 'PREPARED' || syncState === 'SYNCING') {
        setState('SYNCING')
      } else if (syncState === 'RECONNECTING') {
        setState('RECONNECTING')
      } else if (syncState === 'ERROR' || syncState === 'STOPPED') {
        setState('ERROR')
      } else if (syncState === 'CATCHUP') {
        setState(prevState === 'RECONNECTING' ? 'RECONNECTING' : 'SYNCING')
      }
    }

    client.on(sdk.ClientEvent.Sync, onSync)
    return () => { client.off(sdk.ClientEvent.Sync, onSync) }
  }, [])

  return state
}
