import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import { loadPills } from '../lib/roomMeta'

/** The room's saved reply pills, from account data. */
export function useRoomPills(client: sdk.MatrixClient, roomId: string) {
  const [pills, setPills] = useState<string[]>([])

  // Load pills — retry on sync (account data may not be in-memory until first SYNCING)
  useEffect(() => {
    let cancelled = false
    const load = () => loadPills(client, roomId).then(p => { if (!cancelled) setPills(p) })

    load()

    const onSync = (state: string) => { if (state === 'SYNCING') load() }
    const onAccountData = (event: sdk.MatrixEvent) => {
      if (event.getType() === 'com.matrix-pwa.room-pills') load()
    }

    client.on(sdk.ClientEvent.Sync, onSync)
    client.on(sdk.ClientEvent.AccountData, onAccountData)
    return () => {
      cancelled = true
      client.off(sdk.ClientEvent.Sync, onSync)
      client.off(sdk.ClientEvent.AccountData, onAccountData)
    }
  }, [roomId, client])

  return [pills, setPills] as const
}
