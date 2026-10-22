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
//
// Input is stream-json too, with stdin held open, so a message sent while the
// turn runs can steer it (see `steer`). The CLI takes such a message in at the
// next tool boundary and echoes it back (`isReplay`); one that lands while the
// final answer is being written becomes a turn of its own in the same process,
// with its own `result`. So a turn is over only once a `result` arrives with
// every message written also echoed — until then stdin stays open.
import * as fs from 'node:fs'
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
  // Every listed skill's description rides along in each room session. These
  // are office-document and interactive-CLI skills no room has ever invoked;
  // update-config edits ~/.claude/settings.json, which the approval hook never
  // lets an agent touch anyway. "off" hides the skill entirely.
  skillOverrides: Object.fromEntries([
    'anthropic-skills:docx', 'anthropic-skills:pptx', 'anthropic-skills:xlsx',
    'anthropic-skills:pdf', 'anthropic-skills:docs', 'anthropic-skills:google-workspace',
    'anthropic-skills:morning', 'anthropic-skills:import-memory',
    'anthropic-skills:skill-creator', 'keybindings-help', 'update-config',
  ].map((name) => [name, 'off'])),
})

// Turns in flight, so a turn can be stopped or steered without waiting it out.
// Keyed by room because that is the unit the bot serialises on — a room has at
// most one. Each entry is { child, write } where `write(text)` hands the turn
// another user message, or returns false once the turn is wrapping up.
const running = new Map()

const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'

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
  if (block.name === 'Artifact') {
    const action = block.input?.action ?? 'publish'
    const content = action === 'publish' ? (block.input?.asset ? 'Uploading to a page' : 'Publishing a page')
      : action === 'read' ? 'Reading a page' : action === 'list' ? 'Listing pages' : 'Using artifacts'
    return { id: block.id, emoji: '📄', tool: 'artifact', content }
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

// A card holds the latest lines only; a long subagent run would otherwise grow
// one Matrix event past what a phone wants to render, or the 64K event limit.
const SUBAGENT_LINES = 30
const SUMMARY_LIMIT = 4000

const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

// How task_notification statuses read on a card. Anything unrecognised is
// treated as stopped rather than claiming it worked.
const SUBAGENT_STATUS = { completed: 'completed', failed: 'failed', error: 'failed' }

// Follows the subagents of one turn through the stream: the main agent's
// Task/Agent call opens one, its own tool calls (parent_tool_use_id) become its
// lines, and the CLI's task_* system events carry its type, live usage and final
// report. `onChange(card)` gets a fresh snapshot every time one moves; the card
// is what the room sees, so it holds the same safe lines the main agent's
// progress does and never the subagent's prompt. Integers only — Matrix rejects
// event content with floats in it.
export function createSubagentTracker({ cwd = '', onChange } = {}) {
  const cards = new Map()
  // A subagent's own Task call: its events belong on the outer card.
  const owner = new Map()
  // Tool calls seen per card. The CLI's own count lags or leads it, so a card
  // shows whichever is higher rather than adding the two.
  const seen = new Map()

  const emit = (card) => {
    try { onChange?.({ ...card, lines: [...card.lines] }) } catch {}
  }

  const open = (block) => {
    const description = typeof block.input?.description === 'string' ? oneLine(block.input.description) : 'Subagent'
    const agentType = typeof block.input?.subagent_type === 'string' ? block.input.subagent_type : undefined
    const card = {
      id: block.id, description, agentType, background: block.input?.run_in_background === true,
      status: 'running', lines: [], toolUses: 0, tokens: 0, durationMs: 0, startedAt: Date.now(),
    }
    cards.set(block.id, card)
    emit(card)
  }

  const cardFor = (toolUseId) => cards.get(owner.get(toolUseId) ?? toolUseId)

  const usage = (card, u) => {
    if (!u || typeof u !== 'object') return
    if (Number.isFinite(u.tool_uses)) card.toolUses = Math.max(card.toolUses, Math.round(u.tool_uses))
    if (Number.isFinite(u.total_tokens)) card.tokens = Math.round(u.total_tokens)
    if (Number.isFinite(u.duration_ms)) card.durationMs = Math.round(u.duration_ms)
  }

  // True when the event was a subagent's and nothing else should act on it.
  const handle = (event) => {
    if (!event || typeof event !== 'object') return false
    if (event.type === 'assistant' && !event.parent_tool_use_id) {
      for (const block of event.message?.content ?? []) {
        if (block?.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name) && block.id && !cards.has(block.id)) open(block)
      }
      return false
    }
    if (event.type === 'assistant' && event.parent_tool_use_id) {
      const card = cardFor(event.parent_tool_use_id)
      if (!card) return true
      let moved = false
      for (const block of event.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue
        if (SUBAGENT_TOOLS.has(block.name) && block.id) owner.set(block.id, card.id)
        const line = progressForToolUse(block, cwd)
        if (!line) continue
        const { id: _, ...rest } = line
        card.lines.push(rest)
        if (card.lines.length > SUBAGENT_LINES) card.lines.shift()
        seen.set(card.id, (seen.get(card.id) ?? 0) + 1)
        card.toolUses = Math.max(card.toolUses, seen.get(card.id))
        moved = true
      }
      if (moved) emit(card)
      return true
    }
    if (event.type !== 'system') return false
    const card = event.tool_use_id ? cardFor(event.tool_use_id) : null
    if (!card || card.id !== event.tool_use_id) return false
    switch (event.subtype) {
      case 'task_started':
        if (typeof event.subagent_type === 'string') card.agentType = event.subagent_type
        if (typeof event.is_backgrounded === 'boolean') card.background = event.is_backgrounded
        emit(card)
        return true
      case 'task_progress':
        usage(card, event.usage)
        emit(card)
        return true
      case 'task_notification': {
        usage(card, event.usage)
        card.status = SUBAGENT_STATUS[event.status] ?? 'stopped'
        if (typeof event.summary === 'string' && event.summary.trim()) {
          const s = event.summary.trim()
          card.summary = s.length > SUMMARY_LIMIT ? `${s.slice(0, SUMMARY_LIMIT - 1)}…` : s
        }
        emit(card)
        return true
      }
      default:
        return false
    }
  }

  // The process is gone: whatever still says running never will finish.
  const close = () => {
    for (const card of cards.values()) {
      if (card.status !== 'running') continue
      card.status = 'stopped'
      card.durationMs ||= Date.now() - card.startedAt
      emit(card)
    }
  }

  return { handle, close, isSubagentCall: (block) => block?.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name) }
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/
const ARTIFACT_VERSION = /\(Version (\d+)/

// What a published page calls itself: its <title>, which the Artifact tool
// also reads from the first 8KB.
function pageTitle(filePath, cwd) {
  try {
    const full = path.isAbsolute(filePath) ? filePath : path.join(cwd || '', filePath)
    const fd = fs.openSync(full, 'r')
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(buf.toString('utf8', 0, n))
    return m ? m[1].replace(/\s+/g, ' ').trim() || null : null
  } catch {
    return null
  }
}

const resultText = (content) => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : ''

// Pairs each Artifact publish call (the agent's or a subagent's) with the
// result that names its claude.ai URL, and reports the page once that result
// arrives: `onArtifact({ url, title, description, version, file? })`. Asset uploads,
// reads, lists and the rest are not pages and say nothing.
export function createArtifactWatcher({ cwd = '', onArtifact } = {}) {
  const calls = new Map()
  return (event) => {
    if (event?.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block?.type !== 'tool_use' || block.name !== 'Artifact' || !block.id) continue
        const input = block.input ?? {}
        if ((input.action ?? 'publish') !== 'publish' || input.asset) continue
        calls.set(block.id, input)
      }
      return
    }
    if (event?.type !== 'user' || !calls.size) return
    const content = event.message?.content
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue
      const input = calls.get(block.tool_use_id)
      calls.delete(block.tool_use_id)
      if (block.is_error) continue
      const text = resultText(block.content)
      const url = ARTIFACT_URL.exec(text)?.[0]
      if (!url) continue
      const title = (typeof input.title === 'string' && input.title.trim())
        || (typeof input.file_path === 'string' && (pageTitle(input.file_path, cwd) ?? path.basename(input.file_path).replace(/\.[^.]+$/, '')))
        || 'Artifact'
      const version = Number(ARTIFACT_VERSION.exec(text)?.[1]) || undefined
      const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined
      // The page as published, for a copy Construct can show in-app. Only a
      // single .html page is the whole thing; one with supporting files isn't.
      const file = typeof input.file_path === 'string' && /\.html?$/i.test(input.file_path) && !input.files && !input.type_url
        ? (path.isAbsolute(input.file_path) ? input.file_path : path.join(cwd || '', input.file_path))
        : undefined
      try { onArtifact?.({ url, title: oneLine(title), description, version, ...(file ? { file } : {}) }) } catch {}
    }
  }
}

export const claude = {
  name: 'claude',
  models: MODELS,
  defaultModel: MODELS.opus,

  processRoots() {
    return [...running].filter(([, { child }]) => child.pid && child.exitCode === null).map(([roomId, { child }]) => ({
      pid: child.pid, id: `claude-${child.pid}`, label: 'Claude agent', roomIds: [roomId], shared: false, mapping: 'dedicated-room',
    }))
  },

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
  // `onSubagent(card)`, when given, takes over reporting subagents: each one
  // becomes a card that is re-sent as it moves, instead of a single progress line.
  // `onArtifact(page)` hears of every page published to claude.ai in the turn.
  run({ roomId, prompt, cwd, model, sessionId, instructions = [], approval, onProgress, onText, onSubagent, onArtifact, timeoutMs, onSession }) {
    const args = [
      '-p',
      // stream-json in print mode refuses to run without --verbose.
      '--output-format', 'stream-json', '--verbose',
      '--input-format', 'stream-json', '--replay-user-messages',
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
        stdio: ['pipe', 'pipe', 'pipe'],
        // The hook runs as a grandchild of this process; hand it the broker
        // address so an overridden port stays consistent.
        env: {
          ...process.env,
          AGENT_APPROVAL_URL: approval.url,
          AGENT_APPROVAL_TIMEOUT_MS: String(approval.timeoutMs),
          // Which room to ask. Cannot be derived from the session id during a
          // room's first turn, because that id is only known once it ends.
          AGENT_ROOM_ID: roomId,
          // The account's claude.ai connectors (Figma, Claude Docs, Gmail,
          // Calendar, Drive) were never called from a room, but their
          // instructions and tool names were re-sent on every reconnect —
          // ~10K tokens over one long session.
          ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
          // Claude's Artifact tools (publish an HTML page to claude.ai, its
          // comments and data) are on in the interactive CLI but off by default
          // in -p ("sdk_default_off" in the CLI); this is the CLI's own opt-in.
          // Auto-open would try to launch a browser on the Pi after a publish.
          CLAUDE_CODE_ARTIFACT: '1',
          CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0',
        },
      })
      // Messages written but not yet echoed back as taken in.
      let unread = 0
      let closing = false
      const write = (text) => {
        if (closing || !child.stdin.writable) return false
        unread++
        child.stdin.write(userLine(text))
        return true
      }
      // A process that dies early must not crash the bot on a write to it.
      child.stdin.on('error', () => { closing = true })
      running.set(roomId, { child, write })
      write(prompt)

      let result = null
      let partial = ''
      let stderr = ''
      let timedOut = false
      const reported = new Set()
      const subagents = onSubagent ? createSubagentTracker({ cwd, onChange: onSubagent }) : null
      const artifacts = onArtifact ? createArtifactWatcher({ cwd, onArtifact }) : null
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
        if (event.type === 'user' && event.isReplay) { unread = Math.max(0, unread - 1); return }
        if (event.type === 'result') {
          // An earlier result answered a message that one sent mid-answer has
          // since overtaken. Its text is still held in `pendingText`, so the next
          // turn's first block posts it as narration like any other.
          result = event
          if (unread === 0) {
            closing = true
            child.stdin.end()
          }
          return
        }
        // Before the subagent tracker, which keeps a subagent's events to itself.
        artifacts?.(event)
        if (subagents?.handle(event)) return
        for (const block of mainAgentBlocks(event)) {
          if (block?.type === 'text' && block.text?.trim()) {
            flushText()
            pendingText = block.text.trim()
            continue
          }
          // Its card says it, and keeps saying it as the subagent works.
          if (subagents?.isSubagentCall(block)) {
            flushText()
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
        subagents?.close()
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
    const turn = running.get(roomId)
    if (!turn) return false
    turn.child.kill('SIGTERM')
    return true
  },

  // Hands a message to the turn in flight, which reads it at its next tool
  // boundary — or answers it right after, if it lands mid-answer. False when
  // there is no turn or it is already wrapping up; the caller queues it then.
  steer(roomId, text) {
    return running.get(roomId)?.write(text) ?? false
  },
}
