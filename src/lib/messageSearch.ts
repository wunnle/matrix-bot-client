import type * as sdk from 'matrix-js-sdk'
import { parseActions } from './actions'
import { snippet, textMatches } from './commandSearch'

export interface MessageHit {
  roomId: string
  eventId: string
  /** The message around the match, on one line. */
  text: string
  sender: string
  ts: number
}

/** A message body as someone reads it: no [[buttons]], code fences or markdown marks. */
function plain(body: string): string {
  return parseActions(body).text
    .replace(/```[a-z]*\n?/gi, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
}

/**
 * Messages containing `query`, newest first, from what this device has in
 * memory: each room's live timeline, which is the recent stretch sync brought
 * in plus whatever scrolling back in an open room has paged in. Encrypted
 * rooms can't be searched on the server, so this is the search there is.
 */
export function searchLoadedMessages(client: sdk.MatrixClient, roomIds: string[], query: string, limit = 20): MessageHit[] {
  const hits: MessageHit[] = []
  for (const roomId of roomIds) {
    const room = client.getRoom(roomId)
    if (!room) continue
    for (const e of room.getLiveTimeline().getEvents()) {
      if (e.getType() !== 'm.room.message' || e.isRedacted()) continue
      const content = e.getContent()
      if (content['m.relates_to']?.rel_type === 'm.replace') continue
      const shown = e.replacingEvent()?.getContent()?.['m.new_content'] ?? content
      if (shown['com.construct.tool_progress'] || typeof shown.body !== 'string') continue
      const text = plain(shown.body)
      if (!textMatches(query, text)) continue
      const id = e.getId()
      if (!id) continue
      const senderId = e.getSender() ?? ''
      hits.push({
        roomId,
        eventId: id,
        text: snippet(text, query),
        sender: room.getMember(senderId)?.name ?? senderId.replace(/^@/, '').split(':')[0],
        ts: e.getTs(),
      })
    }
  }
  return hits.sort((a, b) => b.ts - a.ts).slice(0, limit)
}

/** "14:05" today, "Yesterday", "Tue" this week, else "12 Nov". */
export function shortWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const day = 86_400_000
  if (ts >= today.getTime()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (ts >= today.getTime() - day) return 'Yesterday'
  if (ts >= today.getTime() - 6 * day) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
