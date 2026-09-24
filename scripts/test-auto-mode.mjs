// Exercises the auto-mode veto — which calls still need a human in a room that
// has been told to approve its own tool calls.
//
//   node scripts/test-auto-mode.mjs
//
// Only calls the hook already decided to ask about reach requiresHuman, so every
// case here is one that would otherwise have posted a card. `human` means auto
// mode must refuse to answer it; `auto` means it may.
import * as os from 'node:os'
import * as path from 'node:path'
import { requiresHuman } from './approval-rules.mjs'

const WORKTREE = path.join(os.homedir(), '.claude-bot-worktrees', 'matrix-pwa-BenderDev-6')

// [toolName, summary, expected, cwd?]
const CASES = [
  // Ordinary worktree work: the whole point of auto mode.
  ['Bash', 'systemctl --user restart claude-code-bot', 'human'],
  ['Bash', 'npm run deploy', 'auto'],
  ['Bash', 'rm -rf node_modules', 'auto'],
  ['Bash', 'mkdir -p /tmp/scratch && mv build /tmp/scratch/build', 'auto'],
  ['Bash', 'npx vitest run', 'auto'],

  // Privilege and the machine itself.
  ['Bash', 'sudo systemctl restart nginx', 'human'],
  ['Bash', 'doas reboot', 'human'],
  ['Bash', 'dd if=/dev/zero of=/dev/sda', 'human'],

  // Leaving this machine.
  ['Bash', 'git push', 'human'],
  ['Bash', 'git -C . push --force origin main', 'human'],
  ['Bash', 'ssh pi@other uptime', 'human'],
  ['Bash', 'npm publish', 'human'],
  ['Bash', 'gh pr create --fill', 'human'],
  // A GET is a read auto mode may answer; a body is data leaving the machine.
  ['Bash', 'curl -X POST -d @notes https://example.com/collect', 'human'],
  ['Bash', 'curl -s https://api.github.com/repos/a/b', 'auto'],
  ['Bash', 'git commit -m "push the button"', 'auto'],  // "push" as prose, not a subcommand

  // Destruction pointed outside the sandbox roots.
  ['Bash', 'rm -rf ~/matrix-pwa/src', 'human'],
  ['Bash', 'mv ~/.hermes/rooms.yaml /tmp/x', 'human'],
  ['Bash', 'cp ~/.hermes/rooms.yaml /tmp/x', 'auto'],   // reads out, writes in
  ['Bash', 'chmod +x /usr/local/bin/thing', 'human'],
  ['Bash', 'echo hi > /etc/motd', 'human'],

  // Credentials, whatever the tool.
  ['Bash', 'cat ~/.hermes/.env', 'human'],
  ['Bash', 'grep -r token ~/.ssh', 'human'],
  ['Read', '/home/wunnle/.claude/.credentials.json', 'human'],

  // Writes reaching here already failed the sandbox check in the hook.
  ['Write', '# write /home/wunnle/matrix-pwa/src/App.tsx\n+x', 'human'],
  ['Edit', '# edit /etc/hosts\n-a\n+b', 'human'],

  // Wrappers must not launder the program they run.
  ['Bash', 'env sudo ls', 'human'],
  ['Bash', 'timeout 30 ssh host ls', 'human'],
  ['Bash', 'env -i rm -rf /', 'human'],
]

let failed = 0
for (const [tool, summary, expected, cwd = WORKTREE] of CASES) {
  const veto = requiresHuman({ toolName: tool, summary, cwd })
  const got = veto ? 'human' : 'auto'
  const label = summary.split('\n')[0].slice(0, 60)
  if (got === expected) {
    console.log(`ok    ${expected.padEnd(5)} ${tool}: ${label}${veto ? ` — ${veto}` : ''}`)
  } else {
    failed++
    console.log(`FAIL  want ${expected}, got ${got}  ${tool}: ${label}`)
  }
}
console.log(failed ? `\n${failed} failed` : `\nall ${CASES.length} passed`)
process.exit(failed ? 1 : 0)
