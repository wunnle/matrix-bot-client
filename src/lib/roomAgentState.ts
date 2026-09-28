import type * as sdk from 'matrix-js-sdk'
import { agentActivityAt, agentRunFrom, type RunMessage } from '../hooks/useAgentActivity'
import { AGENT_BLOCKED_EVENT } from '../hooks/useAgentBlocked'
import { parseActions } from './actions'
import { getRoomOwners } from './roomOwners'

/**
 * What a room tile should say about its agent, derived from the room as the
 * SDK already holds it — the same signals the open room uses, so the grid and
 * the room never disagree.
 *
 * In priority order: the agent is paused on you (an approval card or a
 * question), it is stuck on its usage limit, it is mid-run, or it is idle.
 */
export type RoomAgentState =
  | { kind: 'approval' }
  | { kind: 'question' }
  | { kind: 'blocked' }
  | { kind: 'working'; label: string }
  | { kind: 'idle' }

interface TimelineMessage extends RunMessage {
  body: string
}

type Content = Record<string, unknown>

/** The effective content of a message event, edits applied. */
function effectiveContent(event: sdk.MatrixEvent): Content {
  const raw = (event.getContent() ?? {}) as Content
  const replacing = event.replacingEvent()
  if (replacing) return { ...raw, ...(replacing.getContent()?.['m.new_content'] as Content | undefined) }
  const relation = raw['m.relates_to'] as { rel_type?: string } | undefined
  if (relation?.rel_type === 'm.replace' && raw['m.new_content']) {
    return { ...raw, ...(raw['m.new_content'] as Content) }
  }
  return raw
}

function isToolLine(l: unknown): l is { emoji: string; tool: string } {
  const line = l as { emoji?: unknown; tool?: unknown } | null
  return !!line && typeof line.emoji === 'string' && typeof line.tool === 'string'
}

function timelineMessages(room: sdk.Room, userId: string): TimelineMessage[] {
  const owners = getRoomOwners(room)
  const out: TimelineMessage[] = []
  for (const event of room.getLiveTimeline().getEvents()) {
    // Still-encrypted events read as m.room.encrypted until they decrypt.
    if (event.getType() !== 'm.room.message') continue
    const content = effectiveContent(event)
    const sender = event.getSender() ?? ''
    const isOwnMessage = sender === userId
    const rawTools = content['com.construct.tool_progress']
    const toolProgress = Array.isArray(rawTools)
      ? rawTools.filter(isToolLine).map((l) => ({ emoji: l.emoji, tool: l.tool }))
      : undefined
    out.push({
      isOwnMessage,
      isPeerMessage: !isOwnMessage && owners.size > 0 && !owners.has(sender),
      toolProgress: toolProgress?.length ? toolProgress : undefined,
      interim: content['com.construct.interim'] === true ? true : undefined,
      // Only its presence matters here; ChatView parses the kind and source.
      machine: content['com.construct.machine'] ? {} : undefined,
      timestamp: event.getTs(),
      body: typeof content.body === 'string' ? content.body : '',
    })
  }
  return out
}

export function roomAgentState(room: sdk.Room, userId: string, now: number): RoomAgentState {
  const messages = timelineMessages(room, userId)

  // The last thing that isn't the agent narrating its own progress.
  let last: TimelineMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m.isOwnMessage && (m.toolProgress || m.interim)) continue
    last = m
    break
  }

  if (last && !last.isOwnMessage) {
    const { actions } = parseActions(last.body)
    if (actions.some((a) => a.toLowerCase() === 'approve')) return { kind: 'approval' }
    if (last.body.startsWith('❓')) return { kind: 'question' }
  }

  const blocked = room.currentState.getStateEvents(AGENT_BLOCKED_EVENT as keyof sdk.StateEvents, '')?.getContent()
  if (blocked?.blocked) return { kind: 'blocked' }

  const botTyping = room.getMembers().some((m) => m.userId !== userId && m.typing)
  const activity = agentActivityAt(agentRunFrom(messages), botTyping, Math.floor(now / 1000))
  if (activity) return { kind: 'working', label: activity.label }
  // Some turns aren't started by a message of yours — a background task
  // finishing wakes the agent up after its last reply — so there is no run to
  // find. The typing flag still says it is working, and that is enough.
  if (botTyping) return { kind: 'working', label: 'Working' }

  return { kind: 'idle' }
}

/** Cheap equality, so an unchanged room doesn't re-render its tile. */
export function sameAgentState(a: RoomAgentState | undefined, b: RoomAgentState): boolean {
  if (!a || a.kind !== b.kind) return false
  if (a.kind === 'working') return a.label === (b as typeof a).label
  return true
}
