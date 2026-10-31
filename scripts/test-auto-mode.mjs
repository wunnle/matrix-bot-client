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
  ['Bash', 'cp /etc/hostname /tmp/x', 'auto'],   // reads out, writes in
  ['Bash', 'cp ~/.hermes/rooms.yaml /tmp/x', 'auto'],
  ['Bash', 'cp ~/.hermes/.env /tmp/x', 'human'],  // …unless what it reads is a secret
  ['Bash', 'chmod +x /usr/local/bin/thing', 'human'],
  ['Bash', 'echo hi > /etc/motd', 'human'],
  // Creating files anywhere in $HOME is fine; the gate and shell startup are not.
  ['Bash', 'ln -sfn /home/wunnle/matrix-pwa/node_modules node_modules', 'auto'],
  ['Bash', 'echo "- x" >> ~/Documents/Obsidian/Daily\\ Notes/today.md', 'auto'],
  ['Bash', 'echo "alias x=y" >> ~/.bashrc', 'human'],
  ['Bash', 'cp /tmp/page ~/.local/bin/page', 'human'],
  ['Bash', 'cp /tmp/tool ~/.local/bin/colonist-keys', 'auto'],

  // User services: restart freely, except the bot that runs every room.
  ['Bash', 'systemctl --user restart pebble-index.service', 'auto'],
  ['Bash', 'systemctl --user daemon-reload && systemctl --user restart colonist-katan-sync.timer', 'auto'],
  ['Bash', 'systemctl restart nginx', 'human'],
  ['Bash', 'systemctl --user poweroff', 'human'],
  ['Bash', 'systemctl --user status claude-code-bot', 'auto'],

  // Reading GitHub is a GET; changing it is not.
  ['Bash', 'gh repo view simbasjungles/free-my-tv', 'auto'],
  ['Bash', 'gh api repos/a/b/readme --jq .content', 'auto'],
  ['Bash', 'gh release list --repo a/b --limit 3', 'auto'],
  ['Bash', 'gh api -X PATCH user/repository_invitations/1', 'human'],
  ['Bash', 'gh api repos/a/b/issues -f title=x', 'human'],
  ['Bash', 'gh release download v1 --repo a/b', 'human'],
  ['Bash', 'curl -s -X HEAD https://example.com/', 'auto'],

  // Hermes code and logs are not credentials; its keys still are.
  ['Bash', 'tail -15 ~/.hermes/profiles/colonist/logs/agent.log', 'auto'],
  ['Bash', 'grep -E "^MATRIX_ALLOWED_USERS=" ~/.hermes/.env', 'human'],

  // Credentials, whatever the tool.
  ['Bash', 'cat ~/.hermes/.env', 'human'],
  ['Bash', 'grep -r token ~/.ssh', 'human'],
  ['Read', '/home/wunnle/.claude/.credentials.json', 'human'],
  ['Read', '/home/wunnle/.config/gh/hosts.yml', 'human'],
  ['Bash', 'cat "/home/wunnle/.vercel-bender-token"', 'human'],
  // The Codex shape: the command, then the directory it runs in.
  ['Bash', `cat ~/.hermes/.env\n# in ${WORKTREE}`, 'human'],
  ['Bash', 'cat scripts/.claude-bot-store/.session.json', 'human'],

  // Writes reaching here already failed the sandbox check in the hook. In auto
  // mode they may go anywhere in $HOME but a short protected list.
  ['Write', '# write /home/wunnle/matrix-pwa/src/App.tsx\n+x', 'auto'],
  ['Edit', '# edit /home/wunnle/Documents/Obsidian/People/Dang Nguyen.md\n-a\n+b', 'auto'],
  ['Edit', '# edit /home/wunnle/.config/systemd/user/pebble-index.service\n-a\n+b', 'auto'],
  // Mentioning a secret in the text is not writing to it.
  ['Edit', '# edit /home/wunnle/Documents/Obsidian/Bender/Functionalities/Hermes.md\n-a\n+see ~/.hermes/.env', 'auto'],
  ['Edit', '# edit /etc/hosts\n-a\n+b', 'human'],
  ['Edit', '# edit /home/wunnle/.hermes/.env\n-a\n+b', 'human'],
  ['Edit', '# edit /home/wunnle/.hermes/config.yaml\n-a\n+b', 'human'],
  ['Edit', '# edit /home/wunnle/.claude/settings.json\n-a\n+b', 'human'],
  ['Edit', '# edit /home/wunnle/.bashrc\n-a\n+b', 'human'],
  ['Write', '# write /home/wunnle/matrix-pwa/scripts/approval-rules.mjs\n+x', 'human'],
  ['Edit', '# edit /home/wunnle/.claude/projects/-home-wunnle-matrix-pwa/memory/x.md (all occurrences)\n-a\n+b', 'auto'],

  // Wrappers must not launder the program they run.
  ['Bash', 'env sudo ls', 'human'],
  ['Bash', 'timeout 30 ssh host ls', 'human'],
  ['Bash', 'env -i rm -rf /', 'human'],
  ['Bash', 'construct-preview 5173 -- git push', 'human'],
  ['Bash', 'construct-preview 5173 -- sudo npm run dev', 'human'],
  ['Bash', 'construct-preview 5173 -- npm run dev', 'auto'],
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
// The read tools carry their input, because a Glob's summary has no pattern in
// it; the reason is what the card shows.
for (const [tool, input, expected] of [
  ['Glob', { pattern: '~/.ssh/*' }, 'it reads a secret file'],
  ['Grep', { pattern: 'token', path: os.homedir() }, 'it reads a secret file'],
  ['Read', { file_path: '/home/wunnle/.hermes/.env' }, 'it reads a secret file'],
]) {
  const got = requiresHuman({ toolName: tool, summary: JSON.stringify(input), cwd: WORKTREE, input })
  if (got === expected) console.log(`ok    human ${tool}: ${JSON.stringify(input)} — ${got}`)
  else { failed++; console.log(`FAIL  want "${expected}", got "${got}"  ${tool}: ${JSON.stringify(input)}`) }
}
console.log(failed ? `\n${failed} failed` : `\nall ${CASES.length + 3} passed`)
process.exit(failed ? 1 : 0)
