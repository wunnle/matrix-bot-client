// PreToolUse hook — asks for approval in the agent's Matrix room.
//
// Claude Code runs this before every tool call, passing the call on stdin. Tools
// that only read local state are allowed outright; anything that can change the
// world (or reach outside the room's directory) is sent to the bot's approval
// broker, which posts it to the room and blocks until the human answers.
//
// Wired up via --settings; see APPROVAL_SETTINGS in claude-code-bot.mjs.
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  AUTO_ALLOW, PATH_SCOPED, SAFE_SKILLS, artifactIsSafe, bashIsSafe, commandWords, isSandboxPath,
  linksToSecret, stripHeredocs, toolReadsSecret,
} from './approval-rules.mjs'

const BROKER_URL = process.env.AGENT_APPROVAL_URL ?? 'http://127.0.0.1:8787/approve'

// Long enough for a human to notice a notification and answer; the broker
// applies its own deadline too.
const TIMEOUT_MS = Number(process.env.AGENT_APPROVAL_TIMEOUT_MS ?? 10 * 60 * 1000)

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { raw += c })
    process.stdin.on('end', () => resolve(raw))
  })
}

// A path alone says nothing about what the edit does, so file-writing tools get
// their content rendered as a diff. Long bodies are clipped — the point is to
// judge the change, not to read the whole file in a chat bubble.
const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const MAX_DIFF_LINES = 40
const MAX_LINE = 200

// The whole change is sent alongside the clipped one so the room can offer it
// on demand. Capped well under Matrix's 64KB event limit.
const MAX_FULL_CHARS = 24000

function clip(text, marker, maxLines) {
  const lines = String(text ?? '').split('\n')
  const shown = lines.slice(0, maxLines)
    .map((l) => `${marker}${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l}`)
  if (lines.length > shown.length) shown.push(`${marker}… ${lines.length - shown.length} more lines`)
  return shown.join('\n')
}

function diffBlock(oldText, newText, maxLines) {
  return [clip(oldText, '-', maxLines), clip(newText, '+', maxLines)].filter(Boolean).join('\n')
}

// One-line summary of the call, for the approval message in chat. `maxLines`
// caps each side of a change; pass Infinity for the untrimmed version.
function describe(toolName, input, maxLines = MAX_DIFF_LINES) {
  if (toolName === 'Bash') return input?.command ?? '(no command)'
  const target = input?.file_path ?? input?.path ?? input?.notebook_path

  if (toolName === 'Edit' && target) {
    const all = input.replace_all ? ' (all occurrences)' : ''
    return `# edit ${target}${all}\n${diffBlock(input.old_string, input.new_string, maxLines)}`
  }
  if (toolName === 'MultiEdit' && target) {
    const edits = (input.edits ?? [])
      .map((e, i) => `# change ${i + 1}\n${diffBlock(e.old_string, e.new_string, maxLines)}`)
      .join('\n\n')
    return `# edit ${target}\n${edits}`
  }
  if (toolName === 'Write' && target) {
    return `# write ${target}\n${clip(input.content, '+', maxLines)}`
  }
  if (toolName === 'NotebookEdit' && target) {
    const mode = input.edit_mode ?? 'replace'
    return `# notebook ${mode} ${target} (cell ${input.cell_id ?? '?'})\n${clip(input.new_source, '+', maxLines)}`
  }

  if (target) return target
  const url = input?.url
  if (url) return url
  const json = JSON.stringify(input ?? {})
  return json.length > 200 ? `${json.slice(0, 200)}…` : json
}

const raw = await readStdin()
let payload
try {
  payload = JSON.parse(raw)
} catch {
  // A hook that can't parse its own input must not silently allow the call.
  decide('deny', 'Approval hook could not parse its input.')
}

const toolName = payload.tool_name ?? 'unknown'
const toolInput = payload.tool_input ?? {}
const sessionId = payload.session_id
const cwd = payload.cwd ?? process.cwd()

// Harness-owned, turn-scoped tools enforce lineage/capacity/worktree boundaries server-side.
if (process.env.AGENT_FAMILY_TOKEN && ['mcp__agent_rooms__spawn_agent', 'mcp__agent_rooms__list_agents', 'mcp__agent_rooms__message_agent'].includes(toolName)) {
  decide('allow', 'Independent agent coordination authorized by the room policy.')
}

// The rules are pure; following a symlink is the one read of the disk they
// need, so it is lent from here. A missing path simply has no link to follow.
const realpath = (p) => fs.realpathSync(p)

// Read-only tools are allowed outright, except when what they read is a
// credential. Reading changes nothing locally, which is why these are on the
// list; but reading is how a secret leaves, and WebFetch is on the same list.
const readTargets = [toolInput.file_path, toolInput.notebook_path, toolInput.path]
if (AUTO_ALLOW.has(toolName) && !toolReadsSecret(toolName, toolInput, cwd) && !linksToSecret(readTargets, cwd, realpath)) {
  decide('allow', 'Read-only tool.')
}

if (toolName === 'Artifact' && artifactIsSafe(toolInput, cwd)) {
  decide('allow', 'Artifact publish to the user\'s own claude.ai, private by default.')
}

if (toolName === 'Skill' && SAFE_SKILLS.has(toolInput.skill)) {
  decide('allow', `Pre-approved skill: ${toolInput.skill}.`)
}

if (PATH_SCOPED.has(toolName)) {
  const target = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path
  if (target && isSandboxPath(target, cwd)) {
    decide('allow', 'Write inside the session directory or scratch space.')
  }
}

if (toolName === 'Bash' && bashIsSafe(toolInput.command, cwd)
  && !linksToSecret(commandWords(stripHeredocs(toolInput.command ?? '')), cwd, realpath)) {
  decide('allow', 'Bash command on the allowlist.')
}

// Everything else — mutating Bash, writes outside the directory, unknown tools — asks.
const summary = describe(toolName, toolInput)
const untrimmed = describe(toolName, toolInput, Infinity)
// Only worth carrying when it says more than the card already does.
const full = untrimmed !== summary ? untrimmed.slice(0, MAX_FULL_CHARS) : undefined

let res
try {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  res = await fetch(BROKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // The room is authoritative; sessionId is only a fallback for the broker.
      roomId: process.env.AGENT_ROOM_ID,
      sessionId,
      toolName,
      summary,
      full,
      // Tells the bot to render this as a diff rather than a plain block.
      lang: DIFF_TOOLS.has(toolName) ? 'diff' : undefined,
      cwd,
      // A read tool only reaches here for reading a secret; auto mode needs
      // its input to see that, because a Glob's summary omits the pattern.
      input: AUTO_ALLOW.has(toolName) ? toolInput : undefined,
      // Set only when a subagent made the call, so the card can say whose it is.
      agentType: typeof payload.agent_type === 'string' ? payload.agent_type : undefined,
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer))
} catch (e) {
  decide('deny', `Could not reach the approval broker (${e.message}). Denied by default.`)
}

if (!res.ok) {
  decide('deny', `Approval broker returned ${res.status}. Denied by default.`)
}

const body = await res.json().catch(() => null)
if (body?.decision === 'allow') decide('allow', body.reason ?? 'Approved in chat.')
decide('deny', body?.reason ?? 'Denied in chat.')
