// PreToolUse hook — asks for approval in the agent's Matrix room.
//
// Claude Code runs this before every tool call, passing the call on stdin. Tools
// that only read local state are allowed outright; anything that can change the
// world (or reach outside the room's directory) is sent to the bot's approval
// broker, which posts it to the room and blocks until the human answers.
//
// Wired up via --settings; see APPROVAL_SETTINGS in claude-code-bot.mjs.
import * as path from 'node:path'

const BROKER_URL = process.env.AGENT_APPROVAL_URL ?? 'http://127.0.0.1:8787/approve'
// Long enough for a human to notice a notification and answer; the broker
// applies its own deadline too.
const TIMEOUT_MS = Number(process.env.AGENT_APPROVAL_TIMEOUT_MS ?? 10 * 60 * 1000)

// Read-only inspection of the local checkout — no side effects worth a prompt.
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead', 'WebSearch'])
// Writes are fine inside the room's own directory; outside it they need a human.
const PATH_SCOPED = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

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

// One-line summary of the call, for the approval message in chat.
function describe(toolName, input) {
  if (toolName === 'Bash') return input?.command ?? '(no command)'
  const target = input?.file_path ?? input?.path ?? input?.notebook_path
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

if (AUTO_ALLOW.has(toolName)) decide('allow', 'Read-only tool.')

if (PATH_SCOPED.has(toolName)) {
  const target = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path
  if (target) {
    const resolved = path.resolve(cwd, target)
    const root = path.resolve(cwd)
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      decide('allow', 'Write inside the session directory.')
    }
  }
}

// Everything else — Bash, writes outside the directory, unknown tools — asks.
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
      summary: describe(toolName, toolInput),
      cwd,
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
