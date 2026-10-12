import type { MatrixClient } from 'matrix-js-sdk'
import type { RoomViewKind } from '../../lib/roomView'
import { useWatchlist } from '../../hooks/useWatchlist'
import WatchlistView from './WatchlistView'

function WatchlistPage({ client, roomId }: { client: MatrixClient, roomId: string }) {
  const { items, status, act, add } = useWatchlist(client, roomId)
  return <WatchlistView items={items} status={status} onAction={act} onAdd={add} />
}

/** The page for a room's view kind. One entry per kind in ROOM_VIEW_KINDS. */
export default function RoomPage({ kind, client, roomId }: { kind: RoomViewKind, client: MatrixClient, roomId: string }) {
  switch (kind) {
    case 'watchlist': return <WatchlistPage client={client} roomId={roomId} />
  }
}
