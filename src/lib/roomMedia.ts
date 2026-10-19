import type { Message, SharedLocation } from '../types'

/**
 * What a room's side panel lists: the links, images, files, places and
 * Linear issues / GitHub PRs in its loaded messages, newest first, each
 * pointing back at the message it came from.
 */

export interface RoomLink { url: string; title?: string; host: string; eventId: string; timestamp: number }
export interface RoomMediaItem { eventId: string; name: string; timestamp: number }
export interface RoomPlace { location: SharedLocation; eventId: string; timestamp: number }
export interface RoomRef { kind: 'linear' | 'github'; label: string; url: string; title?: string; eventId: string; timestamp: number }

export interface RoomMedia {
  links: RoomLink[]
  images: RoomMediaItem[]
  files: RoomMediaItem[]
  places: RoomPlace[]
  refs: RoomRef[]
}

// Bare issue keys only for the teams that are actually used: a generic
// [A-Z]+-\d+ also matches UTF-8, SHA-256, ISO-8601.
const LINEAR_TEAMS = ['BEN']
const LINEAR_WORKSPACE = 'wunnle'
const LINEAR_KEY = new RegExp(`\\b((?:${LINEAR_TEAMS.join('|')})-\\d{1,5})\\b`, 'g')
const LINEAR_URL = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)/i
const GITHUB_REF = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/

const BODY_URL = /https?:\/\/[^\s<>"'`)\]]+/g
const HTML_ANCHOR = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// A sentence's closing punctuation is not part of the URL it ends with.
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return undefined }
}

/** Every http(s) link in a message, with the anchor text when it has some. */
function messageLinks(m: Message): { url: string; title?: string }[] {
  const out: { url: string; title?: string }[] = []
  if (m.formattedBody) {
    HTML_ANCHOR.lastIndex = 0
    for (let a = HTML_ANCHOR.exec(m.formattedBody); a; a = HTML_ANCHOR.exec(m.formattedBody)) {
      const url = decodeEntities(a[1])
      const text = decodeEntities(a[2].replace(/<[^>]+>/g, '')).trim()
      out.push({ url, title: text && text !== url ? text : undefined })
    }
  }
  // Plain bodies, and autolinked URLs a formatter left as text.
  for (const raw of m.body.match(BODY_URL) ?? []) out.push({ url: trimUrl(raw) })
  for (const card of m.cards ?? []) {
    if (card.url) out.push({ url: card.url, title: card.title })
    for (const a of card.actions ?? []) out.push({ url: a.url, title: `${card.title}: ${a.label}` })
  }
  return out
}

export function collectRoomMedia(messages: Message[], linearWorkspace = LINEAR_WORKSPACE): RoomMedia {
  const links = new Map<string, RoomLink>()
  const refs = new Map<string, RoomRef>()
  const images: RoomMediaItem[] = []
  const files: RoomMediaItem[] = []
  const places: RoomPlace[] = []

  // Oldest to newest, so a later mention replaces an earlier one and the
  // entry points at the latest message; a title, once known, is kept.
  for (const m of messages) {
    if (m.isDecryptionFailure || m.toolProgress) continue
    const at = { eventId: m.eventId, timestamp: m.timestamp }

    if (m.imageMxc) images.push({ ...at, name: m.caption ?? m.body })
    if (m.fileMxc) files.push({ ...at, name: m.fileName ?? m.body })
    if (m.location) places.push({ ...at, location: m.location })
    for (const p of m.places ?? []) places.push({ ...at, location: p })

    const addRef = (ref: Omit<RoomRef, 'eventId' | 'timestamp'>) => {
      const prev = refs.get(ref.label)
      refs.delete(ref.label)
      refs.set(ref.label, { ...ref, title: ref.title ?? prev?.title, ...at })
    }

    // A shared location's body is a maps link to itself; the place covers it.
    if (!m.location) {
      for (const { url, title } of messageLinks(m)) {
        const host = hostOf(url)
        if (!host) continue
        const linear = LINEAR_URL.exec(url)
        if (linear) { addRef({ kind: 'linear', label: linear[1].toUpperCase(), url, title }); continue }
        const gh = GITHUB_REF.exec(url)
        if (gh) {
          const [base, owner, repo, , num] = gh
          addRef({ kind: 'github', label: `${owner}/${repo}#${num}`, url: base, title: title === url ? undefined : title })
          continue
        }
        const key = url.replace(/#.*$/, '').replace(/\/$/, '')
        const prev = links.get(key)
        links.delete(key)
        links.set(key, { url, host, title: title ?? prev?.title, ...at })
      }
    }

    // Issue keys written out in text, outside any link.
    const text = m.body.replace(BODY_URL, '')
    LINEAR_KEY.lastIndex = 0
    for (let k = LINEAR_KEY.exec(text); k; k = LINEAR_KEY.exec(text)) {
      addRef({ kind: 'linear', label: k[1], url: `https://linear.app/${linearWorkspace}/issue/${k[1]}` })
    }
  }

  return {
    links: [...links.values()].reverse(),
    images: images.reverse(),
    files: files.reverse(),
    places: places.reverse(),
    refs: [...refs.values()].reverse(),
  }
}

export function isEmptyRoomMedia(media: RoomMedia): boolean {
  return !media.links.length && !media.images.length && !media.files.length && !media.places.length && !media.refs.length
}
