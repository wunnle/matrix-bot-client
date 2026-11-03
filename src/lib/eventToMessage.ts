import * as sdk from 'matrix-js-sdk'
import type { Message, ConstructThread, ToolProgressLine, SubagentCard } from '../types'
import { getRoomOwners } from './roomOwners'
import type { EncryptedFile } from './attachmentCrypto.js'
import { parseArtifact } from './artifact'
import { parseBrowserPage } from './browser'
import { extractFormBlock, formResponseFromContent } from './form'
import { extractLocationBlocks, locationFromContent } from './location'
import { sanitizeHtml } from './sanitizeHtml'
import { shortUserId } from './chatFormat'

export function getMaxReadTs(room: sdk.Room, userId: string): number {
  let max = 0
  for (const member of room.getMembers()) {
    if (member.userId === userId || member.membership !== 'join') continue
    const readUpTo = room.getEventReadUpTo(member.userId)
    if (!readUpTo) continue
    const readEvent = room.findEventById(readUpTo)
    if (!readEvent) continue
    const ts = readEvent.getTs()
    if (ts > max) max = ts
  }
  return max
}

export function eventToMessage(
  event: sdk.MatrixEvent,
  userId: string,
  maxReadTs: number,
  room?: sdk.Room,
  owners?: Set<string>,
): Message {
  const isFailure = event.isDecryptionFailure()
  const isEncrypted = event.getType() === 'm.room.encrypted'
  // Resolve the effective content, honoring two edit shapes:
  // 1. This event was edited → use the replacement's m.new_content
  // 2. This event IS the replacement (m.relates_to.rel_type=m.replace) →
  //    use its own m.new_content directly (timeline rendered the edit as
  //    a standalone bubble, e.g. streamed tool-progress updates).
  // Custom fields like com.construct.tool_progress live in m.new_content;
  // without this merge, only the top-level body (with `*` prefix) is read.
  const rawContent = event.getContent() ?? {}
  const replacing = (event as any).replacingEvent?.()
  const isReplacementItself = rawContent?.['m.relates_to']?.rel_type === 'm.replace'
  let content = rawContent
  if (replacing) {
    content = { ...rawContent, ...(replacing.getContent()?.['m.new_content'] ?? {}) }
  } else if (isReplacementItself && rawContent?.['m.new_content']) {
    content = { ...rawContent, ...(rawContent['m.new_content'] as Record<string, unknown>) }
  }
  let body = content?.body ?? ''
  let imageUrl: string | undefined

  if (isFailure || (isEncrypted && !body)) {
    body = '🔒 Unable to decrypt'
  } else if ((content?.msgtype === 'm.image' || content?.msgtype === 'm.file') && (content?.url || content?.file?.url)) {
    body = content.body ?? ''
  }

  // An agent's ```location blocks become map cards; the text around them stays.
  const rawHtml = !isFailure && content?.format === 'org.matrix.custom.html' && typeof content?.formatted_body === 'string'
    ? content.formatted_body as string
    : undefined
  const placed = isFailure ? undefined : extractLocationBlocks(String(body), rawHtml)
  if (placed?.locations.length) body = placed.body
  let html = placed?.locations.length ? placed.html : rawHtml
  // Same for a ```form block: it becomes a checklist under the text.
  const asked = isFailure ? undefined : extractFormBlock(String(body), html)
  if (asked?.form) ({ body, html } = asked)

  let formattedBody: string | undefined
  if (html) formattedBody = sanitizeHtml(html)

  const sender = event.getSender() ?? ''
  const isOwnMessage = sender === userId
  const isRead = isOwnMessage && event.getTs() <= maxReadTs

  const roomOwners = owners ?? getRoomOwners(room)
  const isPeerMessage = !isOwnMessage && roomOwners.size > 0 && !roomOwners.has(sender)
  const senderName = isPeerMessage
    ? (room?.getMember(sender)?.rawDisplayName || shortUserId(sender))
    : undefined
  // Unlike senderName this is set for every message, peer or not: the meta row
  // names the author for anything that isn't the user's own message.
  const authorName = room?.getMember(sender)?.rawDisplayName || shortUserId(sender)

  // Encrypted rooms carry the attachment as content.file (ciphertext url plus
  // its key) instead of content.url; the mxc is the same kind of handle either way.
  const mediaFile = !content?.url && typeof content?.file?.url === 'string' ? content.file as EncryptedFile : undefined
  const mediaMxc: string | undefined = content?.url || mediaFile?.url || undefined
  const imageMxc = content?.msgtype === 'm.image' ? mediaMxc : undefined
  const fileMxc = content?.msgtype === 'm.file' ? mediaMxc : undefined
  // With a caption, body is the caption and filename the original name;
  // without one, body is the name.
  const mediaFilename = typeof content?.filename === 'string' ? content.filename : undefined
  const caption = (imageMxc || fileMxc) && mediaFilename && body && body !== mediaFilename ? body : undefined
  const fileName = fileMxc ? (mediaFilename ?? content?.body ?? 'file') : undefined
  const fileMime = fileMxc ? (content?.info?.mimetype ?? 'application/octet-stream') : undefined
  const location = isFailure ? undefined : locationFromContent(content)

  const rawCards = content?.['com.construct.cards']
  const cards = Array.isArray(rawCards)
    ? rawCards
        .filter((c: any) => c && typeof c === 'object' && typeof c.title === 'string')
        .map((c: any) => ({
          title: String(c.title),
          subtitle: typeof c.subtitle === 'string' ? c.subtitle : undefined,
          description: typeof c.description === 'string' ? c.description : undefined,
          image: typeof c.image === 'string' ? c.image : undefined,
          fields: Array.isArray(c.fields)
            ? c.fields
                .filter((f: any) => f && typeof f.label === 'string' && typeof f.value === 'string')
                .map((f: any) => ({ label: String(f.label), value: String(f.value) }))
            : undefined,
          price: typeof c.price === 'string' ? c.price : undefined,
          url: typeof c.url === 'string' && /^https?:\/\//.test(c.url) ? c.url : undefined,
          actions: Array.isArray(c.actions)
            ? c.actions
                .filter((a: any) => a && typeof a.label === 'string' && typeof a.url === 'string' && /^https?:\/\//.test(a.url))
                .map((a: any) => ({ label: String(a.label), url: String(a.url) }))
            : undefined,
        }))
    : undefined

  const parseThread = (t: any): ConstructThread | null =>
    t && typeof t === 'object' && typeof t.title === 'string' && typeof t.body === 'string'
      ? { title: String(t.title), summary: typeof t.summary === 'string' ? t.summary : undefined, body: String(t.body) }
      : null
  const rawThreads = content?.['com.construct.threads'] ?? content?.['com.construct.thread']
  const threads = Array.isArray(rawThreads)
    ? (rawThreads.map(parseThread).filter(Boolean) as ConstructThread[])
    : rawThreads ? ([parseThread(rawThreads)].filter(Boolean) as ConstructThread[]) : undefined

  const rawToolProgress = content?.['com.construct.tool_progress']
  const toolProgress: ToolProgressLine[] | undefined = Array.isArray(rawToolProgress)
    ? rawToolProgress
        .filter((l: any) => l && typeof l.emoji === 'string' && typeof l.tool === 'string')
        .map((l: any) => ({
          emoji: String(l.emoji),
          tool: String(l.tool),
          content: typeof l.content === 'string' ? l.content : undefined,
          repeat: typeof l.repeat === 'number' ? l.repeat : undefined,
          raw: `${l.emoji} ${l.tool}${l.content ? `: "${l.content}"` : '...'}`,
        }))
    : undefined

  const subagent = parseSubagent(content?.['com.construct.subagent'])
  const artifact = parseArtifact(content?.['com.construct.artifact'])
  const browser = parseBrowserPage(content?.['com.construct.browser'])

  const source = typeof content?.['com.construct.source'] === 'string'
    ? String(content['com.construct.source'])
    : undefined

  const rawMachine = content?.['com.construct.machine']
  const machine = rawMachine && typeof rawMachine === 'object'
    ? {
        kind: typeof (rawMachine as any).kind === 'string' ? String((rawMachine as any).kind) : undefined,
        source: typeof (rawMachine as any).source === 'string' ? String((rawMachine as any).source) : undefined,
      }
    : rawMachine === true ? {} : undefined

  const rawApproval = content?.['com.construct.approval']
  const approval = rawApproval && typeof rawApproval === 'object'
    && typeof rawApproval.body === 'string' && typeof rawApproval.title === 'string'
    ? {
        title: String(rawApproval.title),
        lines: Number(rawApproval.lines) || String(rawApproval.body).split('\n').length,
        body: String(rawApproval.body),
      }
    : undefined

  return {
    eventId: event.getId() ?? event.getTs().toString(),
    sender: event.getSender() ?? '',
    body,
    formattedBody,
    imageUrl,
    imageMxc,
    fileMxc,
    mediaFile,
    fileName,
    fileMime,
    caption,
    location,
    places: placed?.locations.length ? placed.locations : undefined,
    form: asked?.form,
    formResponse: isOwnMessage ? formResponseFromContent(content) : undefined,
    cards: cards && cards.length > 0 ? cards : undefined,
    threads: threads && threads.length > 0 ? threads : undefined,
    approval,
    toolProgress: toolProgress && toolProgress.length > 0 ? toolProgress : undefined,
    subagent,
    artifact,
    browser,
    timestamp: event.getTs(),
    isOwnMessage,
    isPeerMessage,
    senderName,
    authorName,
    isDecryptionFailure: isFailure,
    isRead,
    source,
    machine,
    interim: content?.['com.construct.interim'] === true ? true : undefined,
  }
}

const SUBAGENT_STATUSES = new Set(['running', 'completed', 'failed', 'stopped'])

// com.construct.subagent, as the bot's subagent cards send it
// (scripts/subagent-cards.mjs). Anything malformed is no card at all.
function parseSubagent(value: unknown): SubagentCard | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.description !== 'string') return undefined
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const lines: ToolProgressLine[] = []
  for (const item of Array.isArray(raw.lines) ? raw.lines : []) {
    const l = item as Record<string, unknown> | null
    if (!l || typeof l.emoji !== 'string' || typeof l.tool !== 'string') continue
    lines.push({ emoji: l.emoji, tool: l.tool, content: typeof l.content === 'string' ? l.content : undefined })
  }
  return {
    id: raw.id,
    description: raw.description,
    agentType: typeof raw.agentType === 'string' ? raw.agentType : undefined,
    background: raw.background === true,
    status: typeof raw.status === 'string' && SUBAGENT_STATUSES.has(raw.status) ? raw.status as SubagentCard['status'] : 'stopped',
    lines,
    toolUses: num(raw.toolUses) ?? lines.length,
    tokens: num(raw.tokens),
    durationMs: num(raw.durationMs),
    startedAt: num(raw.startedAt),
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary : undefined,
  }
}

function buildReactionsMap(events: sdk.MatrixEvent[]): Record<string, Record<string, string[]>> {
  const map: Record<string, Record<string, string[]>> = {}
  for (const e of events) {
    if (e.getType() !== 'm.reaction') continue
    const rel = e.getContent()['m.relates_to']
    if (!rel || rel.rel_type !== 'm.annotation') continue
    const targetId = rel.event_id as string
    const emoji = rel.key as string
    const sender = e.getSender() ?? ''
    if (!map[targetId]) map[targetId] = {}
    if (!map[targetId][emoji]) map[targetId][emoji] = []
    if (!map[targetId][emoji].includes(sender)) map[targetId][emoji].push(sender)
  }
  return map
}

export function eventsToMessages(events: sdk.MatrixEvent[], userId: string, room: sdk.Room): Message[] {
  const maxReadTs = getMaxReadTs(room, userId)
  const owners = getRoomOwners(room)
  const reactionsMap = buildReactionsMap(events)
  const messageEvents = events
    .filter((e) => e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted' || e.isDecryptionFailure())
  // Fold m.replace edits into their target: render the newest edit's
  // content inside the target bubble and hide the edit events themselves.
  // Edits whose target sits outside the loaded window keep the newest
  // edit as a standalone bubble so the content isn't lost.
  const presentIds = new Set(messageEvents.map((e) => e.getId() ?? ''))
  const latestEditByTarget = new Map<string, sdk.MatrixEvent>()
  for (const e of messageEvents) {
    const rel = e.getRelation()
    if (rel?.rel_type === 'm.replace' && rel.event_id) latestEditByTarget.set(rel.event_id, e)
  }
  const standaloneEditIds = new Set(
    [...latestEditByTarget.entries()]
      .filter(([targetId]) => !presentIds.has(targetId))
      .map(([, e]) => e.getId() ?? '')
  )
  return messageEvents
    .filter((e) => {
      const rel = e.getRelation()
      if (rel?.rel_type !== 'm.replace' || !rel.event_id) return true
      return standaloneEditIds.has(e.getId() ?? '')
    })
    .map((e) => {
      const id = e.getId() ?? ''
      const edit = latestEditByTarget.get(id)
      let msg = eventToMessage(edit ?? e, userId, maxReadTs, room, owners)
      if (edit) msg = { ...msg, eventId: id, timestamp: e.getTs() }
      const reactions = reactionsMap[msg.eventId]
      return reactions ? { ...msg, reactions } : msg
    })
}
