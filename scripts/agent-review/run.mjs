// Weekly agent review. Collects a week of signals for one set of agents, then
// hands them to a Claude turn in the "Agent review" room, which verifies them
// and suggests at most five improvements. Run by agent-review@<kind>.timer.
//
//   node scripts/agent-review/run.mjs <hermes|claude> [--days N] [--collect-only]
//
// --collect-only writes the findings file and stops, without starting a turn.
// Prints one line either way.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { collectHermes } from './collect-hermes.mjs'
import { collectClaude } from './collect-claude.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const STATE = path.join(REPO, '.agent-review')
const TOKEN_FILE = path.join(REPO, 'scripts', '.claude-bot-store', 'schedule.token')
const PORT = Number(process.env.AGENT_APPROVAL_PORT ?? 8787)

const KINDS = {
  hermes: {
    label: 'Hermes (Bender and the other profiles)',
    collect: collectHermes,
    sources: [
      '   - Conversations: `node ~/matrix-pwa/scripts/agent-review/session.mjs <profile|default> <session_id> [--from N] [--max CHARS]` prints one, and `… <profile> --list [days]` lists recent ones. It is pre-approved; writing your own script to read a state.db is not, and would stop the run on an approval.',
      '   - Logs: `~/.hermes/logs/` and `~/.hermes/profiles/<name>/logs/` (`agent.log` names the model that actually answered).',
    ],
    scope: [
      '   - Room prompts in `~/.hermes/rooms.yaml`, `~/.hermes/SOUL.md`, skills under `~/.hermes/skills/` and `~/.hermes/profiles/*/skills/`, scripts in `~/.hermes/scripts/`, memories in `~/.hermes/memories/` and `~/.hermes/profiles/*/memories/`.',
      '   - The design notes in `~/Documents/Obsidian/Bender/Functionalities/`: read the matching note, Gotchas especially, before suggesting a change to that area.',
    ],
  },
  claude: {
    label: 'the Claude bots (agent rooms and other Claude Code sessions on the Pi)',
    collect: collectClaude,
    sources: [
      '   - Transcripts: `~/.claude/projects/<project>/<session>.jsonl`; the finding names the project. Read them with `jq` (the directory names start with `-`, so pass `./-home-…`).',
      '   - The bot log: always by its full path, `grep … ~/matrix-pwa/scripts/.claude-bot-store/bot.log`. Never `cd` into `.claude-bot-store`: it holds the bot\'s tokens, so every command run from inside it asks for approval.',
    ],
    scope: [
      '   - `~/.claude/CLAUDE.md`, project CLAUDE.md files, memories in `~/.claude/projects/-home-wunnle-matrix-pwa/memory/`, helpers in `~/.local/bin/`.',
      '   - `~/.claude/skills/`, `commands/` and `settings.json`: agents cannot edit these; a fix there is a script Sinan runs.',
      '   - The bot and its approval rules: `scripts/claude-code-bot.mjs`, `scripts/approval-rules.mjs` in `~/matrix-pwa`.',
    ],
  },
}

const args = process.argv.slice(2)
const kind = KINDS[args[0]]
if (!kind) {
  console.error('usage: run.mjs <hermes|claude> [--days N] [--collect-only]')
  process.exit(2)
}
const days = Number(args[args.indexOf('--days') + 1]) || 7
const date = new Date().toISOString().slice(0, 10)

const report = await kind.collect(days)
fs.mkdirSync(STATE, { recursive: true })
const findings = path.join(STATE, `findings-${args[0]}-${date}.md`)
fs.writeFileSync(findings, report.markdown())

if (!report.count) {
  console.log(`agent-review ${args[0]}: quiet week, nothing to review`)
  process.exit(0)
}
if (args.includes('--collect-only')) {
  console.log(`agent-review ${args[0]}: ${report.count} signals → ${findings}`)
  process.exit(0)
}

const title = `${args[0] === 'hermes' ? 'Hermes' : 'Claude bots'} review · ${date}`
const prompt = fs.readFileSync(path.join(import.meta.dirname, 'instructions.md'), 'utf8')
  .replaceAll('{{LABEL}}', kind.label)
  .replaceAll('{{DAYS}}', String(days))
  .replaceAll('{{FINDINGS}}', findings)
  .replaceAll('{{STATE}}', STATE)
  .replaceAll('{{SOURCES}}', kind.sources.join('\n'))
  .replaceAll('{{SCOPE}}', kind.scope.join('\n'))
  .replaceAll('{{TITLE}}', title)

const res = await fetch(`http://127.0.0.1:${PORT}/scheduled-turn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${fs.readFileSync(TOKEN_FILE, 'utf8').trim()}` },
  body: JSON.stringify({
    key: 'agent-review',
    name: 'Agent review',
    // Its own folder, not the repo: decisions.md is writable without a tap and
    // session.mjs stays a pre-approved script rather than one the room could edit.
    cwd: STATE,
    notice: `🔎 ${title}: ${report.count} signals from the last ${days} days. Checking them now.`,
    prompt,
  }),
}).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }))
const body = await res.json().catch(() => ({}))
console.log(`agent-review ${args[0]}: ${report.count} signals → ${res.ok ? `turn started in ${body.roomId}` : `not started (${res.status}: ${body.error})`}`)
process.exit(res.ok ? 0 : 1)
