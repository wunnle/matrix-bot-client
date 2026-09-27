// Claude Code provider — runs a turn by shelling out to `claude -p`.
//
// One process per turn, so there is no connection to keep alive: the session
// lives on disk under the id the CLI hands back, and `--resume` picks it up.
// Approvals leave this process entirely — the PreToolUse hook posts them to the
// bot's broker over loopback (see claude-approval-hook.mjs), so the adapter's
// only job there is to pass the broker's address down to the hook.
//
// Output is stream-json rather than json so tool calls can be reported while
// the turn is still running; the final `result` event carries exactly what the
// single json object used to.
import * as path from 'node:path'
import { spawn } from 'node:child_process'

// Short names accepted in !spawn / !model, mapped to the exact CLI model ids.
const MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
}

const HOOK_PATH = path.join(import.meta.dirname, '..', 'claude-approval-hook.mjs')
const APPROVAL_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: `node ${HOOK_PATH}` }] },
    ],
  },
})

// Turns in flight, so a turn can be stopped without waiting it out. Keyed by
// room because that is the unit the bot serialises on — a room has at most one.
const running = new Map()

// Kept stderr is only for the error message; a chatty CLI must not grow it forever.
const STDERR_LIMIT = 64 * 1024

// Tool name -> what the room is told when there is nothing more specific. Raw
// arguments never reach the room: commands, search patterns, queries and URLs
// can carry secrets, and progress lines stay in the room's history. The detail
// a line may carry is chosen per tool in `detailFor`.
const TOOL_PROGRESS = {
  Bash: { emoji: '💻', tool: 'terminal', content: 'Running a command' },
  Read: { emoji: '📖', tool: 'read', content: 'Reading a file' },
  Grep: { emoji: '🔎', tool: 'search', content: 'Searching the code' },
  Glob: { emoji: '🔎', tool: 'search', content: 'Finding files' },
  Edit: { emoji: '✏️', tool: 'edit', content: 'Editing a file' },
  Write: { emoji: '✏️', tool: 'write', content: 'Writing a file' },
  NotebookEdit: { emoji: '✏️', tool: 'edit', content: 'Editing a notebook' },
  WebFetch: { emoji: '🌐', tool: 'fetch', content: 'Fetching a page' },
  WebSearch: { emoji: '🌐', tool: 'websearch', content: 'Searching the web' },
  Task: { emoji: '🤖', tool: 'agent', content: 'Delegating to a subagent' },
  Agent: { emoji: '🤖', tool: 'agent', content: 'Delegating to a subagent' },
}

// Bookkeeping tools: they say nothing about the work, and a line each would
// bury the ones that do.
const SILENT_TOOLS = new Set(['TodoWrite', 'ToolSearch', 'BashOutput', 'KillShell'])

// Long enough for a sentence or a nested path, short enough for a phone row.
const DETAIL_LIMIT = 80

function oneLine(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT - 1)}…` : flat
}

// Repo-relative inside the room's checkout; outside it only the file name,
// since a full path elsewhere (a home dir, a secrets dir) says more than needed.
function displayPath(filePath, cwd) {
  if (!cwd) return path.basename(filePath)
  const rel = path.relative(cwd, filePath)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(filePath)
}

// The safe, specific part of a call, or null to fall back to the generic line.
// Descriptions are prose the agent writes for a human, not the command itself.
function detailFor(name, input, cwd) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null)
  switch (name) {
    case 'Bash':
    case 'Task':
    case 'Agent': {
      const description = str(input?.description)
      return description && oneLine(description)
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const file = str(input?.file_path) ?? str(input?.notebook_path)
      return file && oneLine(displayPath(file, cwd))
    }
    default:
      return null
  }
}

// One `tool_use` content block -> a progress record, or null to say nothing.
export function progressForToolUse(block, cwd = '') {
  if (block?.type !== 'tool_use' || !block.id || !block.name) return null
  if (SILENT_TOOLS.has(block.name)) return null
  const known = TOOL_PROGRESS[block.name]
  if (known) {
    const detail = detailFor(block.name, block.input, cwd)
    return { id: block.id, ...known, ...(detail ? { content: detail } : {}) }
  }
  if (block.name === 'Skill') {
    // A skill name is ours, not user data, and "Using a skill" says nothing.
    const skill = typeof block.input?.skill === 'string' ? block.input.skill : null
    return { id: block.id, emoji: '🧩', tool: 'skill', content: skill ? `Using ${skill}` : 'Using a skill' }
  }
  // mcp__<server>__<tool>: same shape the Codex path gives MCP calls.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(block.name)
  if (mcp) return { id: block.id, emoji: '🔧', tool: mcp[2], content: `Using ${mcp[1]}` }
  return { id: block.id, emoji: '🔧', tool: block.name.toLowerCase(), content: 'Using a tool' }
}

// The content blocks of one stream-json event that the room may hear about, in
// order. Only the main agent's: a subagent's own text and tool use
// (parent_tool_use_id set) would flood the room, and its Task line already
// says one is at work.
export function mainAgentBlocks(event) {
  if (event?.type !== 'assistant' || event.parent_tool_use_id) return []
  const content = event.message?.content
  return Array.isArray(content) ? content : []
}

export const claude = {
  name: 'claude',
  models: MODELS,
  defaultModel: MODELS.opus,

  // Accept a bare alias or a full id; anything else is not ours.
  resolveModel(name) {
    const key = String(name).toLowerCase()
    if (MODELS[key]) return MODELS[key]
    if (Object.values(MODELS).includes(key)) return key
    return null
  },

  // Short alias for a resolved model id, for display.
  label(model) {
    return Object.keys(MODELS).find((k) => MODELS[k] === model) ?? model
  },

  // Runs one turn. `sessionId` resumes the room's prior conversation; the new
  // id comes back through `onSession` so the bot can persist it — the CLI only
  // reveals it once the turn ends, which is why it is a callback and not a
  // return value the caller could rely on mid-turn.
  run({ roomId, prompt, cwd, model, sessionId, instructions = [], approval, onProgress, onText, timeoutMs, onSession }) {
    const args = [
      '-p', prompt,
      // stream-json in print mode refuses to run without --verbose.
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--model', model,
      // The PreToolUse hook is the real gate; see claude-approval-hook.mjs.
      '--settings', APPROVAL_SETTINGS,
    ]
    if (sessionId) args.push('--resume', sessionId)
    // One combined flag: repeating --append-system-prompt only keeps the last.
    if (instructions.length) args.push('--append-system-prompt', instructions.join('\n\n'))

    return new Promise((resolve) => {
      const child = spawn('claude', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The hook runs as a grandchild of this process; hand it the broker
        // address so an overridden port stays consistent.
        env: {
          ...process.env,
          AGENT_APPROVAL_URL: approval.url,
          AGENT_APPROVAL_TIMEOUT_MS: String(approval.timeoutMs),
          // Which room to ask. Cannot be derived from the session id during a
          // room's first turn, because that id is only known once it ends.
          AGENT_ROOM_ID: roomId,
        },
      })
      running.set(roomId, child)

      let result = null
      let partial = ''
      let stderr = ''
      let timedOut = false
      const reported = new Set()
      // Text the agent wrote, held back until the turn shows it goes on. Only
      // then is it narration; the last block is the reply itself, which the
      // `result` event repeats and the caller posts as the turn's answer.
      let pendingText = null

      // Callbacks may not sink the turn: a room that can't be told about
      // progress still gets its answer.
      const flushText = () => {
        if (pendingText !== null) {
          try { onText?.(pendingText) } catch {}
        }
        pendingText = null
      }

      const handleLine = (line) => {
        if (!line.trim()) return
        let event
        try { event = JSON.parse(line) } catch { return }
        if (event.type === 'result') { result = event; return }
        for (const block of mainAgentBlocks(event)) {
          if (block?.type === 'text' && block.text?.trim()) {
            flushText()
            pendingText = block.text.trim()
            continue
          }
          const progress = progressForToolUse(block, cwd)
          // Cheap insurance: nothing documents that a block is streamed once.
          if (!progress || reported.has(progress.id)) continue
          reported.add(progress.id)
          flushText()
          try { onProgress?.(progress) } catch {}
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop()
        lines.forEach(handleLine)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        if (stderr.length < STDERR_LIMIT) stderr += chunk
      })

      // A turn can block on a human answering an approval, so this must
      // exceed the approval timeout rather than race it.
      const timer = timeoutMs ? setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs) : null

      const finish = (outcome) => {
        clearTimeout(timer)
        running.delete(roomId)
        resolve(outcome)
      }
      child.on('error', (err) => finish({ error: err.message }))
      child.on('close', (code, signal) => {
        handleLine(partial)
        if (result) {
          // Held text that isn't the reply (an error result, say) is still
          // something the agent said; post it rather than lose it.
          if (pendingText !== (result.result ?? '').trim()) flushText()
          if (result.session_id) onSession?.(result.session_id)
          return finish({ text: result.result ?? '(no output)', isError: result.is_error })
        }
        // No reply is coming, so whatever the agent last said is all there is.
        flushText()
        if (timedOut) return finish({ error: `Timed out after ${Math.round(timeoutMs / 60000)} min` })
        finish({ error: stderr.trim() || `claude exited without a result (${signal ?? `code ${code}`})` })
      })
    })
  },

  // Stops the turn in flight, if any. The killed process still fires `close`,
  // so the caller gets a resolved turn rather than a hang.
  cancel(roomId) {
    const child = running.get(roomId)
    if (!child) return false
    child.kill('SIGTERM')
    return true
  },
}
