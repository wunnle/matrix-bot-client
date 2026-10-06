/**
 * Reading the bot's approval card (see createApprovalQueue's `present` in
 * scripts/claude-code-bot.mjs), which both Claude and Codex rooms post:
 *
 *   🔐 Approve `Edit`? _(auto mode won't answer this one — <reason>)_
 *
 *   ```diff
 *   # edit /path/to/file.md
 *   …
 *   ```
 *
 *   [[Deny]] [[Approve]] [[Always allow]] [[Approve + auto]]
 *
 * Always allow is Codex-only; Approve + auto is offered while auto mode is off.
 *
 * Hermes rooms post the same card (the construct-matrix plugin rewrites
 * Hermes' exec approval into it), with `_(flagged — <reason>)_` as the reason
 * and [[Approve session]] in place of Always allow.
 */
export interface ApprovalCard {
  /** The tool asking, e.g. "Edit" or "Bash". */
  tool: string
  /** What it touches: a file's name for edits, the command's first line otherwise. */
  target?: string
  /** Why auto mode left this one to you, when that's why you're being asked. */
  reason?: string
}

export function parseApprovalCard(body: string): ApprovalCard | null {
  const head = /^\s*🔐\s*Approve\s+`([^`]+)`/.exec(body)
  if (!head) return null
  const reason = /(?:auto mode won't answer this one|flagged)\s*[—-]\s*([^)]+)\)/.exec(body)?.[1]?.trim()
  return { tool: head[1], target: cardTarget(body), reason }
}

function cardTarget(body: string): string | undefined {
  const fence = /(`{3,})[a-z]*\n([\s\S]*?)\n\1/.exec(body)
  if (!fence) return undefined
  const lines = fence[2].split('\n').map((l) => l.trim()).filter(Boolean)
  // Edits open with a "# <verb> <path>" header; Codex may put a "# reason"
  // line first, so look for the one naming a path.
  for (const line of lines) {
    const path = /^#\s+[\w ]+?\s+(\/\S.*?)(?:\s+\(.*\))?$/.exec(line)?.[1]
    if (path) return path.split('/').pop() || path
  }
  // Commands: the command itself.
  return lines.find((l) => !l.startsWith('#'))
}

/** The labels a card offers, matched loosely so a changed capitalisation doesn't lose a button. */
export function approvalChoices(actions: string[]) {
  const find = (re: RegExp) => actions.find((a) => re.test(a.trim()))
  return {
    approve: find(/^approve$/i),
    deny: find(/^deny$/i),
    always: find(/^always allow$/i),
    // Hermes: approve this kind of command for the rest of the session.
    session: find(/^approve session$/i),
    // Approve this call and turn the room's auto mode on; one answer to the bot.
    auto: find(/^approve \+ auto$/i),
  }
}
