// Artifact cards: a room message for each page an agent publishes to claude.ai
// (providers/claude.mjs, createArtifactWatcher). Construct draws
// `com.construct.artifact` as a card and lists it in the room's sidebar; other
// clients get the link. Republishing a page edits its card rather than posting
// another, which is what the registry is for: room -> page URL -> first event.
import * as fs from 'node:fs'

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// A copy of the page bigger than this stays on claude.ai only.
export const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024

// `snapshot` is the uploaded copy of the page Construct previews in-app:
// { url } in a plain room, { file } (encrypted attachment) in an encrypted
// one, plus its size. claude.ai can't be framed, so this is the only way to
// show the page without leaving the app.
export function artifactContent({ url, title, description, version, snapshot }) {
  return {
    msgtype: 'm.text',
    body: `📄 ${title}: ${url}`,
    format: 'org.matrix.custom.html',
    formatted_body: `📄 <a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`,
    'com.construct.artifact': {
      url, title,
      ...(description ? { description } : {}),
      ...(Number.isInteger(version) ? { version } : {}),
      ...(snapshot ? { snapshot } : {}),
    },
    // The agent's reply says it published something; the card shouldn't
    // notify a second time.
    'com.construct.machine': { kind: 'notification', source: 'claude-artifact' },
  }
}

export function artifactEdit(eventId, content) {
  return {
    msgtype: content.msgtype,
    body: `* ${content.body}`,
    'm.new_content': content,
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    'com.construct.machine': content['com.construct.machine'],
  }
}

// Room state listing a room's artifacts, so Construct finds every card however
// little history it has loaded. Room state is never encrypted, so it carries
// pointers only: the artifact's id and the card's event. Title, description
// and the copy (with its key, in an encrypted room) stay in the card.
export const ARTIFACT_INDEX_EVENT = 'com.construct.artifacts'

const ARTIFACT_ID = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([\w-]+)/

// Newest first. Integers only, as everywhere in event content.
export function artifactIndex(entries) {
  const artifacts = Object.entries(entries ?? {})
    .map(([url, e]) => ({ id: ARTIFACT_ID.exec(url)?.[1], eventId: e?.eventId, updatedAt: Math.round(e?.updatedAt ?? 0) }))
    .filter((a) => a.id && typeof a.eventId === 'string')
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return { artifacts }
}

export function createArtifactRegistry(file) {
  let data = {}
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  return {
    get: (roomId, url) => data[roomId]?.[url] ?? null,
    entries: (roomId) => ({ ...data[roomId] }),
    rooms: () => Object.keys(data),
    set(roomId, url, entry) {
      data[roomId] = { ...data[roomId], [url]: entry }
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, file)
    },
  }
}
