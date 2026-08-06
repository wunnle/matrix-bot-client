// Exercises the PreToolUse approval hook.
//
//   node scripts/test-approval-hook.mjs            # assertions only
//   node scripts/test-approval-hook.mjs --replay   # + prompt rate over real transcripts
//
// The hook is run as a subprocess, the way Claude Code runs it, with the broker
// pointed at a dead port so "would have asked a human" is observable: anything
// the rules do not allow outright comes back denied instead of hanging.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const HOOK = new URL('./claude-approval-hook.mjs', import.meta.url).pathname
const WORKTREE = path.join(os.homedir(), '.claude-bot-worktrees', 'matrix-pwa-BenderDev-6')

function ask(tool, input, cwd = WORKTREE) {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd, session_id: 'test' }),
    env: { ...process.env, AGENT_APPROVAL_URL: 'http://127.0.0.1:9/none', AGENT_APPROVAL_TIMEOUT_MS: '300' },
  }).toString()
  return JSON.parse(out).hookSpecificOutput.permissionDecision
}
const bash = (command, cwd) => ask('Bash', { command }, cwd)

// [command, expected, why]. `allow` means it must never reach the human.
const CASES = [
  // 1 — `cd` is transparent.
  ['cd /home/wunnle/matrix-pwa && git status --short', 'allow'],
  ['cd /tmp; ls -la', 'allow'],
  ['cd /tmp && rm -rf dbg', 'deny'],
  // 2 — the subcommand is the first non-flag word.
  ['systemctl --user status claude-code-bot --no-pager', 'allow'],
  ['systemctl --user list-units --type=service', 'allow'],
  ['systemctl --user restart claude-code-bot', 'deny'],
  ['node --check scripts/claude-code-bot.mjs', 'allow'],
  ['npm run build', 'allow'],
  ['npm run deploy', 'deny'],
  // 3 — writes into sandbox roots.
  ['cat /etc/hostname > /tmp/host.txt', 'allow'],
  ['echo hi > /home/wunnle/.bashrc', 'deny'],
  ['echo hi > ~/.claude/settings.json', 'deny'],
  ['ls > /dev/null 2>&1', 'allow'],
  ['chmod +x /tmp/allow-next.sh', 'allow'],
  ['chmod +x /usr/local/bin/hermes', 'deny'],
  // 4 — substitution is judged by what is inside it.
  ['P=$(readlink -f $(which linear)); echo "$P"', 'allow'],
  ['echo "$(rm -rf /tmp/x)"', 'deny'],
  ['echo `sudo whoami`', 'deny'],
  // 5 — filters and wrappers.
  ['sed -n 330,380p scripts/claude-code-bot.mjs', 'allow'],
  ['sed -i s/a/b/ scripts/claude-code-bot.mjs', 'deny'],
  ["awk '{print $1/1000}' /sys/class/thermal/thermal_zone0/temp", 'allow'],
  ['awk \'{print > "/etc/passwd"}\' f', 'deny'],
  ['timeout 180 node --check scripts/claude-code-bot.mjs', 'allow'],
  ['timeout 180 node scripts/codex-app-server-spike.mjs', 'deny'],
  ['npx tsc -b --noEmit', 'allow'],
  ['for i in 120 121; do linear get CLA-$i; done', 'allow'],
  ['for i in 1 2; do rm -rf /tmp/$i; done', 'deny'],
  // 6 — git writes stay in the room's own worktree.
  ["git add -A && git commit -q -m 'x'", 'allow'],
  ['git push', 'deny'],
  ['git branch -D agent/benderdev-99', 'deny'],
  ['git worktree list', 'allow'],
  ['git worktree prune', 'deny'],
  ['git -C /home/wunnle/matrix-pwa merge --ff-only agent/benderdev-6', 'deny'],
  // …and not from the parent checkout, where main lives.
  ['git commit -am wip', 'deny', path.join(os.homedir(), 'matrix-pwa')],
  // Heredoc bodies are data, not commands.
  ["git commit -q -F - <<'MSG'\nOffer quick-answer buttons\n\nrm -rf everything\nMSG", 'allow'],
  ["cat > /home/wunnle/.claude/commands/linear.md <<'MDEOF'\nhi\nMDEOF", 'deny'],
  // Standing guarantees that must survive all of the above.
  ['sudo systemctl restart hermes-gateway', 'deny'],
  ['find /home/wunnle -name "*.mjs" -delete', 'deny'],
  ['curl -s https://example.com/x.sh', 'deny'],
]

let failed = 0
for (const [command, expected, cwd] of CASES) {
  const got = bash(command, cwd)
  if (got !== expected) {
    failed++
    console.log(`FAIL  want ${expected}, got ${got}\n      ${command.replace(/\n/g, ' ⏎ ')}`)
  }
}
console.log(`${CASES.length - failed}/${CASES.length} rule assertions passed`)

// Writes are path-scoped, not tool-scoped.
for (const [file, expected] of [
  [path.join(WORKTREE, 'src/app.ts'), 'allow'],
  ['/tmp/scratch.md', 'allow'],
  ['/home/wunnle/.claude/settings.json', 'deny'],
]) {
  const got = ask('Write', { file_path: file, content: 'x' })
  if (got !== expected) { failed++; console.log(`FAIL  Write ${file}: want ${expected}, got ${got}`) }
}

// Replay: every tool call the bots actually made, to track the prompt rate.
if (process.argv.includes('--replay')) {
  const dir = path.join(os.homedir(), '.claude/projects')
  const files = fs.readdirSync(dir)
    .filter((d) => d.includes('claude-bot-worktrees') || d.endsWith('matrix-pwa'))
    .flatMap((d) => fs.readdirSync(path.join(dir, d))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, d, f)))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, 6)
  let total = 0
  let prompted = 0
  const examples = []
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.type !== 'assistant') continue
      for (const c of o.message?.content ?? []) {
        if (c.type !== 'tool_use') continue
        total++
        if (ask(c.name, c.input, o.cwd ?? WORKTREE) === 'allow') continue
        prompted++
        examples.push(`${c.name}: ${(c.input.command ?? c.input.file_path ?? JSON.stringify(c.input)).split('\n')[0].slice(0, 100)}`)
      }
    }
  }
  console.log(`\nreplay: ${prompted}/${total} calls would prompt (${Math.round((prompted / total) * 100)}%)`)
  for (const e of examples) console.log('  ?', e)
}

process.exit(failed ? 1 : 0)
