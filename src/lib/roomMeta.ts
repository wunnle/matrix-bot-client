// Room meta is stored as a JSON block at the end of the room topic,
// separated by a magic delimiter so the human-readable topic is preserved.

const DELIMITER = '\n\n<!--pills'

export interface RoomMeta {
  pills: string[]
}

export function parseTopic(raw: string | undefined): { topic: string; meta: RoomMeta } {
  if (!raw) return { topic: '', meta: { pills: [] } }
  const idx = raw.indexOf(DELIMITER)
  if (idx === -1) return { topic: raw, meta: { pills: [] } }
  const topic = raw.slice(0, idx)
  try {
    const json = raw.slice(idx + DELIMITER.length).replace(/-->$/, '').trim()
    const meta = JSON.parse(json) as RoomMeta
    return { topic, meta }
  } catch {
    return { topic, meta: { pills: [] } }
  }
}

export function encodeTopic(topic: string, meta: RoomMeta): string {
  if (!meta.pills.length) return topic
  return `${topic}${DELIMITER}${JSON.stringify(meta)}-->`
}
