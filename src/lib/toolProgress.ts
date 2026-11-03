import type { Message, ToolProgressLine } from '../types'

export function isToolProgressMessage(_body: string, msg?: Message): boolean {
  return !!msg?.toolProgress
}

// Only the room's own bot gets its tool progress collapsed into a chip. A peer
// agent's progress lines stay attributed to them rather than folding into this
// room's bot narration.
export function isBotToolProgress(msg: Message): boolean {
  return !msg.isOwnMessage && !msg.isPeerMessage && isToolProgressMessage(msg.body, msg)
}

export function parseToolProgressMessage(_body: string, msg?: Message): ToolProgressLine[] {
  return msg?.toolProgress ?? []
}

export function summarizeToolLines(lines: ToolProgressLine[]): string {
  const known: Record<string, number> = {}
  const byName: Record<string, number> = {}
  for (const l of lines) {
    const t = l.tool.toLowerCase()
    const n = l.repeat ?? 1
    const cat =
      t === 'bash' || t === 'terminal' ? 'commands' :
      t === 'edit' || t === 'write' || t === 'patch' ? 'edited' :
      t === 'read' || t === 'read_file' ? 'read' :
      t === 'grep' || t === 'glob' || t === 'search_files' || t === 'search' ? 'searches' :
      t === 'agent' ? 'agents' :
      t === 'skill_view' ? 'skills' :
      null
    if (cat) {
      known[cat] = (known[cat] ?? 0) + n
    } else {
      byName[l.tool] = (byName[l.tool] ?? 0) + n
    }
  }
  const parts: string[] = []
  if (known['commands']) { const v = known['commands']; parts.push(`Ran ${v} command${v === 1 ? '' : 's'}`) }
  if (known['edited']) { const v = known['edited']; parts.push(`edited ${v} file${v === 1 ? '' : 's'}`) }
  if (known['read']) { const v = known['read']; parts.push(`read ${v} file${v === 1 ? '' : 's'}`) }
  if (known['searches']) { const v = known['searches']; parts.push(`${v} search${v === 1 ? '' : 'es'}`) }
  if (known['agents']) { const v = known['agents']; parts.push(`${v} agent${v === 1 ? '' : 's'}`) }
  if (known['skills']) { const v = known['skills']; parts.push(`${v} skill${v === 1 ? '' : 's'}`) }
  for (const [name, v] of Object.entries(byName)) parts.push(`${v}× ${name}`)
  return parts.join(', ') || 'Used tools'
}
