import type { ConstructArtifact } from '../types'
import type { EncryptedFile } from './attachmentCrypto.js'

/**
 * Claude's Artifacts: pages agents publish to claude.ai. The bot posts a
 * `com.construct.artifact` card for each (scripts/artifact-cards.mjs); links
 * pasted as text count too, so the room's sidebar lists them all.
 */

// claude.ai/artifact/{id} and claude.ai/code/artifact/{uuid}.
const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([\w-]+)/

/**
 * The room's artifact index (state, kept by the bot; scripts/artifact-cards.mjs):
 * which event holds each artifact's card, newest first. Pointers only, since
 * room state is unencrypted; the card has the rest.
 */
export const ARTIFACT_INDEX_EVENT = 'com.construct.artifacts'
export interface ArtifactIndexEntry { id: string; eventId: string; updatedAt: number }

export function parseArtifactIndex(content: unknown): ArtifactIndexEntry[] {
  const list = (content as { artifacts?: unknown } | null)?.artifacts
  if (!Array.isArray(list)) return []
  return list.flatMap((raw) => {
    const e = raw as Record<string, unknown> | null
    if (!e || typeof e.id !== 'string' || typeof e.eventId !== 'string' || !e.eventId.startsWith('$')) return []
    return [{ id: e.id, eventId: e.eventId, updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0 }]
  })
}

/** The artifact's id when `url` is a claude.ai artifact link, else null. */
export function artifactIdOf(url: string): string | null {
  return ARTIFACT_URL.exec(url)?.[1] ?? null
}

/** com.construct.artifact from message content, or undefined when it isn't a valid one. */
export function parseArtifact(value: unknown): ConstructArtifact | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.url !== 'string' || !artifactIdOf(raw.url)) return undefined
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Artifact'
  return {
    url: raw.url,
    title,
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined,
    version: typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > 0 ? raw.version : undefined,
    snapshot: parseSnapshot(raw.snapshot),
  }
}

// { url } in a plain room, { file } with the key in an encrypted one.
function parseSnapshot(value: unknown): ConstructArtifact['snapshot'] {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.url === 'string' && raw.url.startsWith('mxc://')) return { mxc: raw.url }
  const file = raw.file as EncryptedFile | undefined
  if (file && typeof file === 'object' && typeof file.url === 'string' && file.url.startsWith('mxc://')) {
    return { mxc: file.url, file }
  }
  return undefined
}
