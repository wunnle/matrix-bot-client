// Claude-bot side of the agent review: a week of Claude Code transcripts (agent
// rooms and anything else on this Pi), the bot's log and its worktrees.
// Read-only throughout.
//
//   node scripts/agent-review/collect-claude.mjs [days]   → findings markdown on stdout
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DAY_MS, clip, createReport, gaveUp, isCorrection, run } from './lib.mjs'
import * as rules from '../approval-rules.mjs'

const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const WORKTREES = process.env.AGENT_WORKTREE_DIR ?? path.join(os.homedir(), '.claude-bot-worktrees')
// The live bot's log, not this checkout's: worktrees have no store of their own.
const BOT_LOG = process.env.AGENT_BOT_LOG ?? path.join(os.homedir(), 'matrix-pwa', 'scripts', '.claude-bot-store', 'bot.log')

// Commands every session runs; repeating them is not a missing tool.
const ORDINARY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'echo', 'pwd', 'cd', 'mkdir',
  'git status', 'git diff', 'git log', 'git add', 'git commit', 'git show', 'git branch', 'git merge', 'git push',
  'git checkout', 'git rev-parse', 'git', 'sed', 'awk', 'sort', 'jq', 'node', 'npm', 'npx', 'date', 'which', 'file',
  'stat', 'rm', 'mv', 'cp', 'ln', 'chmod', 'for', 'while', 'if', 'sleep', 'timeout', 'kill', 'diff', 'python3', 'curl'])
// A session's scratchpad path is unique per session and hides the command behind it.
const SCRATCH = /\/tmp\/claude-\d+\/[^\s'"]*\/scratchpad/g

// House rules from CLAUDE.md and memory that a transcript can show being broken.
const RULE_BREAKS = [
  [/\bpython3? -c\b/, 'python3 -c (use jq or a .mjs file)'],
  [/\b(sed|perl) -i\b/, 'in-place sed/perl edit (use the Edit tool)'],
  [/\bwhile\b[^\n]*\bsleep \d|\bsleep \d+\s*(;|&&)\s*(curl|vercel|gh|git)/, 'hand-written polling loop (use vercel-wait, Monitor or a helper)'],
  [/npm run build[^\n&]*\|[^\n]*&&\s*git push/, 'build piped into push (masks a failed build)'],
  [/\bgit stash( pop)?\s*($|;|&&)/, 'bare git stash (shared stash stack)'],
]

// The bot appends these to a user's prompt; they are not the user's words.
const PROMPT_TAILS = /\n\n(Worker reports \(untrusted|Before you reply, rename|\(Machine notice)/

// Leading `cd x &&` and `S=…;` assignments, then the scratchpad path, so two
// sessions running the same thing compare equal.
function normalize(command) {
  return command.trim().replace(/^((cd\s+\S+|\w+=\S*)\s*(&&|;)?\s*)+/, '').replace(SCRATCH, '$S')
}

function shapeOf(command) {
  const words = normalize(command).split(/\s+/)
  const first = path.basename(words[0] ?? '')
  const second = words[1] && /^[a-z][\w-]*$/.test(words[1]) ? ` ${words[1]}` : ''
  return { shape: `${first}${second}`, first }
}

function transcripts(since) {
  const files = []
  for (const dir of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
    const full = path.join(PROJECTS, dir)
    if (!fs.statSync(full).isDirectory()) continue
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(full, f)
      if (fs.statSync(p).mtimeMs >= since) files.push({ project: dir.replace(/^-home-wunnle-+/, '').replace(/^claude-bot-worktrees-/, ''), file: p })
    }
  }
  return files
}

function scanTranscript({ project, file }, since, found) {
  const toolNames = new Map()
  const commandsHere = new Map()
  let firstPrompt = null
  let lastAssistant = null
  let tokens = 0
  let turns = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.timestamp && Date.parse(e.timestamp) < since) continue
    const when = (e.timestamp ?? '').slice(0, 16)
    const content = e.message?.content
    if (e.type === 'assistant') {
      const u = e.message?.usage
      if (u) tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) / 10 + (u.output_tokens ?? 0) * 5
      for (const b of Array.isArray(content) ? content : []) {
        // "No response requested." is the CLI's placeholder, not an answer.
        if (b.type === 'text' && b.text.trim() && b.text.trim() !== 'No response requested.') {
          lastAssistant = b.text
          if (gaveUp(b.text)) found.gaveUp.push(`${when} ${project}: "${clip(b.text, 220)}"`)
        }
        if (b.type !== 'tool_use') continue
        toolNames.set(b.id, b.name)
        const cmd = b.name === 'Bash' ? String(b.input?.command ?? '') : ''
        if (!cmd) continue
        for (const [re, label] of RULE_BREAKS) if (re.test(cmd)) found.ruleBreaks.push(`${when} ${project} — ${label}: \`${clip(cmd, 140)}\``)
        const { shape, first } = shapeOf(cmd)
        if (!ORDINARY.has(shape) && !ORDINARY.has(first)) {
          const s = found.shapes.get(shape) ?? { sessions: new Set(), n: 0, example: cmd }
          s.sessions.add(file); s.n++
          found.shapes.set(shape, s)
        }
        const exact = clip(normalize(cmd), 120)
        commandsHere.set(exact, (commandsHere.get(exact) ?? 0) + 1)
      }
    } else if (e.type === 'user') {
      if (typeof content === 'string') {
        const said = content.split(PROMPT_TAILS)[0].trim()
        if (!said || said.startsWith('<') || said.startsWith('(Machine notice')) continue
        turns++
        if (firstPrompt === null) { firstPrompt = said; continue }
        if (isCorrection(said)) {
          found.corrections.push(`${when} ${project}\n  - agent: "${clip(lastAssistant, 220)}"\n  - Sinan: "${clip(said, 240)}"`)
        }
        continue
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text' && b.text?.startsWith('[Request interrupted by user')) found.interrupts.push(`${when} ${project}`)
        if (b.type !== 'tool_result' || !b.is_error) continue
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
        const tool = toolNames.get(b.tool_use_id) ?? 'tool'
        const key = `${tool}: ${clip(text, 90).replace(/\d+/g, '#')}`
        const g = found.errors.get(key) ?? { n: 0, sessions: new Set() }
        g.n++; g.sessions.add(file)
        found.errors.set(key, g)
      }
    }
  }
  for (const [cmd, n] of commandsHere) if (n >= 4) found.polling.push(`${project}: ×${n} \`${cmd}\``)
  if (turns) found.sessions.push({ project, tokens, turns, firstPrompt })
}

// Replays the week's approval requests through today's rules, so what is listed
// is what would still interrupt Sinan now, not what already got loosened.
function approvals(since, found) {
  if (!fs.existsSync(BOT_LOG)) return
  const cwd = path.join(WORKTREES, 'matrix-pwa-Review-0')
  const entries = []
  let cur = null
  for (const line of fs.readFileSync(BOT_LOG, 'utf8').split('\n')) {
    const m = /^(\d{4}-\d\d-\d\dT\S+) \[(![^\]]+)\] (.*)$/.exec(line)
    const plain = /^(\d{4}-\d\d-\d\dT\S+) (.*)$/.exec(line)
    if (m || plain) {
      if (cur) entries.push(cur)
      cur = null
      const ts = Date.parse((m ?? plain)[1])
      if (ts < since) continue
      const msg = m ? m[3] : plain[2]
      const r = /^approval requested: (\S+) — ([\s\S]*)$/.exec(msg)
      if (r) cur = { tool: r[1], summary: r[2] }
      else if (/^approval deny: /.test(msg)) found.denied++
      else if (/^Listening…/.test(msg)) found.restarts++
      else if (/⚠️|failed|Error/.test(msg)) {
        const shape = clip(msg, 100).replace(/![\w:.-]+/g, '!room').replace(/\d+/g, '#')
        found.botErrors.set(shape, (found.botErrors.get(shape) ?? 0) + 1)
      }
    } else if (cur) cur.summary += '\n' + line
  }
  if (cur) entries.push(cur)
  for (const e of entries) {
    found.requested++
    let target
    if (e.tool === 'Bash') { if (rules.bashIsSafe(e.summary, cwd)) continue }
    else if (rules.PATH_SCOPED.has(e.tool)) {
      target = /^# (?:edit|write|notebook \S+) (.+?)(?: \(all occurrences\)| \(cell .*\))?$/m.exec(e.summary)?.[1]
      if (target && (rules.isSandboxPath(target, cwd) || rules.isPreapprovedWrite(target, cwd))) continue
    }
    const key = e.tool === 'Bash' ? `Bash: ${clip(e.summary.split('\n')[0], 110)}` : `${e.tool} ${clip(target ?? e.summary, 100)}`
    found.stillAsk.set(key, (found.stillAsk.get(key) ?? 0) + 1)
  }
}

async function worktrees(found) {
  const stale = Date.now() - 2 * DAY_MS
  for (const name of fs.existsSync(WORKTREES) ? fs.readdirSync(WORKTREES) : []) {
    const dir = path.join(WORKTREES, name)
    const ahead = await run('git', ['rev-list', '--count', 'main..HEAD'], { cwd: dir })
    const dirty = await run('git', ['status', '--porcelain'], { cwd: dir })
    const last = await run('git', ['log', '-1', '--format=%ct'], { cwd: dir })
    if (!ahead.ok) continue
    const touched = Math.max(Number(last.out) * 1000, fs.statSync(dir).mtimeMs)
    if (touched > stale) continue
    const commits = Number(ahead.out)
    // A lone package.json is the commit hook's version bump, not lost work.
    const changes = dirty.out.split('\n').filter((l) => l && !/ package\.json$/.test(l)).length
    if (commits || changes) found.worktrees.push(`${name}: ${commits} unmerged commit(s), ${changes} uncommitted file(s), idle since ${new Date(touched).toISOString().slice(0, 10)}`)
  }
}

export async function collectClaude(days = 7) {
  const since = Date.now() - days * DAY_MS
  const found = {
    corrections: [], gaveUp: [], interrupts: [], ruleBreaks: [], polling: [], sessions: [], worktrees: [],
    shapes: new Map(), errors: new Map(), stillAsk: new Map(), botErrors: new Map(),
    requested: 0, denied: 0, restarts: 0,
  }
  const files = transcripts(since)
  for (const t of files) {
    try { scanTranscript(t, since, found) } catch (e) { found.botErrors.set(`unreadable transcript ${t.file}: ${e.message}`, 1) }
  }
  approvals(since, found)
  await worktrees(found)

  const report = createReport('Claude-bot agent review: findings', days)
  report.section('Sinan pushed back', found.corrections.slice(-25),
    `Replies that look like a correction or a repeated ask, across ${files.length} transcripts. Open the transcript around each to see what went wrong.`)
  report.section('Agent gave up', found.gaveUp.slice(-12))
  report.section('Interrupted by Sinan', found.interrupts.slice(-12), 'He hit stop mid-turn. What was the agent doing?')
  report.section('House rules broken', found.ruleBreaks.slice(-15))
  report.section('Commands repeated across sessions', [...found.shapes].filter(([, s]) => s.sessions.size >= 3)
    .sort((a, b) => b[1].sessions.size - a[1].sessions.size).slice(0, 15)
    .map(([shape, s]) => `\`${shape}\` in ${s.sessions.size} sessions (${s.n}×), e.g. \`${clip(s.example, 150)}\``),
  'Helper candidates under the CLAUDE.md "turn repeated processes into tools" rule. Many are fine as they are.')
  report.section('Same command run 4+ times in one session', found.polling.slice(0, 12), 'Polling or retrying by hand.')
  report.section('Tool errors', [...found.errors].sort((a, b) => b[1].n - a[1].n).slice(0, 15)
    .map(([key, g]) => `×${g.n} in ${g.sessions.size} sessions: ${key}`))
  report.section('Approvals that would still ask today', [...found.stillAsk].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([key, n]) => `×${n} ${key}`),
  `${found.requested} approval requests this window, ${found.denied} denied by Sinan. Replayed through the current approval-rules.mjs (non-auto mode).`)
  report.section('Bot log errors', [...found.botErrors].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s, n]) => `×${n} ${s}`),
    found.restarts ? `${found.restarts} bot restarts this window.` : '')
  report.section('Most expensive sessions', found.sessions.sort((a, b) => b.tokens - a.tokens).slice(0, 5)
    .map((s) => `${s.project}: ~${Math.round(s.tokens / 1000)}k weighted tokens over ${s.turns} prompts — "${clip(s.firstPrompt, 140)}"`),
  'Weighted: fresh input + cache writes + cache reads/10 + output×5. Big is fine if the work was big.')
  report.section('Worktrees left behind', found.worktrees)
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await collectClaude(Number(process.argv[2] ?? 7))
  process.stdout.write(report.markdown())
}
