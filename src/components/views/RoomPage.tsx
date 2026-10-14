import type { MatrixClient } from 'matrix-js-sdk'
import type { RoomViewKind } from '../../lib/roomView'
import { useDiscordRoom } from '../../hooks/useDiscordRoom'
import { useWatchlist } from '../../hooks/useWatchlist'
import DiscordView from './DiscordView'
import WatchlistView from './WatchlistView'

function WatchlistPage({ client, roomId }: { client: MatrixClient, roomId: string }) {
  const { items, status, act } = useWatchlist(client, roomId)
  return <WatchlistView items={items} status={status} onAction={act} />
}

function DiscordPage({ client, roomId }: { client: MatrixClient, roomId: string }) {
  const { state, status, act } = useDiscordRoom(client, roomId)
  return <DiscordView state={state} status={status} onAction={act} />
}

/** The page for a room's view kind. One entry per kind in ROOM_VIEW_KINDS. */
export default function RoomPage({ kind, client, roomId }: { kind: RoomViewKind, client: MatrixClient, roomId: string }) {
  switch (kind) {
    case 'watchlist': return <WatchlistPage client={client} roomId={roomId} />
    case 'discord': return <DiscordPage client={client} roomId={roomId} />
  }
}
