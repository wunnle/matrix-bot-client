// Pills are stored in Matrix account data under this event type,
// so no room permissions are required and they sync across devices.

import type { MatrixClient } from 'matrix-js-sdk'

const ACCOUNT_DATA_TYPE = 'com.matrix-pwa.room-pills'

interface PillsStore {
  [roomId: string]: string[]
}

export async function loadPills(client: MatrixClient, roomId: string): Promise<string[]> {
  try {
    const data = client.getAccountData(ACCOUNT_DATA_TYPE)?.getContent<PillsStore>() ?? {}
    return data[roomId] ?? []
  } catch {
    return []
  }
}

export async function savePills(client: MatrixClient, roomId: string, pills: string[]): Promise<void> {
  const existing = client.getAccountData(ACCOUNT_DATA_TYPE)?.getContent<PillsStore>() ?? {}
  await client.setAccountData(ACCOUNT_DATA_TYPE, { ...existing, [roomId]: pills })
}
