// What an agent is allowed to do without asking a human.
//
// Extracted from the PreToolUse hook so the Codex path can apply the same rules.
// Codex gates differently — its sandbox only stops what it cannot do, so it asks
// far less often — but when it does ask, the question is the same one: is this
// command a read, or does it change something? Two implementations of that
// answer would drift, and the quiet direction to drift is towards allowing.
//
// Pure: no I/O, no process exit. The callers decide what to do with the verdict.
import * as path from 'node:path'

// Every agent room gets its own worktree under here. Writes that stay inside a
// worktree (or in scratch space) are cheap to undo and nobody but the agent
// sees them, so they are not worth a prompt on this machine.
const WORKTREES_ROOT = process.env.AGENT_WORKTREES_ROOT
  ?? path.join(process.env.HOME ?? '/home/wunnle', '.claude-bot-worktrees')
// The sandbox repo and anything else built by the newproject flow. Deliberately
// disposable: the work is experiments, the repo is one Sinan treats as
// throwaway, and prompting for every file written there made the room unusable.
// Note this is the one scratch root that is not private — pushing from here
// deploys to a public domain, which is why `git push` is gated separately below.
const PROJECTS_ROOT = process.env.AGENT_PROJECTS_ROOT
  ?? path.join(process.env.HOME ?? '/home/wunnle', 'projects')
const SCRATCH_ROOTS = ['/tmp', '/var/tmp', WORKTREES_ROOT, PROJECTS_ROOT]

// curl stays untrusted in general — it fetches remote code, and `curl … | sh` is
// exactly the shape this hook exists to stop. The single exception is confirming
// a deploy went live, which is the last step of every sandbox turn: a plain GET
// of one of Sinan's own hosts, with the body thrown away. Anything that sends a
// body, changes the method, uploads, or saves the response to a file is out, and
// so is any other host.
const DEPLOY_HOSTS = /^https:\/\/([a-z0-9-]+\.)*kafagoz\.com(\/|$)/i
const CURL_MUTATES = /(^|\s)(-X\s*(?!GET\b)|--request\s+(?!GET\b)|-d\b|--data\S*|-F\b|--form\b|-T\b|--upload-file\b|--config\b|-K\b|-O\b|--remote-name\b)|(^|\s)(-o|--output)\s+(?!\/dev\/null(\s|$))/
function curlIsDeployCheck(tokens) {
  const args = tokens.slice(1)
  if (CURL_MUTATES.test(args.join(' '))) return false
  const urls = args.filter((t) => /^[a-z]+:\/\//i.test(t.replace(/^['"]|['"]$/g, '')))
  // No URL at all is not a deploy check; more than one host widens it silently.
  if (!urls.length) return false
  return urls.every((u) => DEPLOY_HOSTS.test(u.replace(/^['"]|['"]$/g, '')))
}

// True when the turn is running inside the projects tree, where the extra
// latitude below (installs, push) applies.
function inProjects(cwd) {
  const root = path.resolve(PROJECTS_ROOT)
  const here = path.resolve(cwd ?? '.')
  return here === root || here.startsWith(root + path.sep)
}
// Read-only inspection of the local checkout — no side effects worth a prompt.
export const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead', 'WebSearch', 'WebFetch'])
// Writes are fine in the room's own directory and in scratch space (see
// isSandboxPath); anywhere else they need a human.
export const PATH_SCOPED = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
// Invoking one of these only loads its instructions into the turn — every tool
// call the skill then makes comes back through this hook on its own, so this
// grants nothing the skill's own calls would not have to earn separately.
export const SAFE_SKILLS = new Set(['linear', 'next', 'room-rename', 'ship', 'newproject'])

// Bash commands that only read state run without a prompt. Anything unrecognised
// — or any sign of mutation (write redirects, sudo, command substitution, find
// -delete/-exec) — falls through to the human approval broker.
const SAFE_BASH_BINS = new Set([
  'ls', 'cat', 'head', 'tail', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep',
  'rg', 'find', 'wc', 'which', 'type', 'whoami', 'id', 'date', 'env', 'sort',
  'uniq', 'cut', 'tr', 'diff', 'stat', 'file', 'du', 'df', 'tree', 'basename',
  'dirname', 'realpath', 'readlink', 'uname', 'hostname', 'sleep', 'true',
  'false', 'test', '[', '[[', 'jq', 'shasum', 'md5sum', 'cksum', 'column', 'xxd', 'strings',
  'nl', 'tac', 'comm',
  // Read-only inspection of the machine itself: processes, resources, network,
  // hardware, clock. None of these change state without a flag we reject below.
  'ps', 'pgrep', 'top', 'htop', 'free', 'uptime', 'w', 'last', 'lsof', 'ss',
  'netstat', 'ip', 'ifconfig', 'route', 'arp', 'lsblk', 'lscpu', 'lsusb',
  'lspci', 'mount', 'vmstat', 'iostat', 'nproc', 'groups', 'users',
  'getent', 'locale', 'dig', 'host', 'nslookup', 'ping', 'traceroute',
  'timedatectl', 'hostnamectl', 'localectl', 'vcgencmd',
  // Stream editors used as filters. `sed -i` edits in place and `awk` can open
  // files for writing, so both are guarded below rather than trusted outright.
  'awk', 'gawk', 'seq',
])
// Shell keywords that introduce a compound command. `for i in 1 2; do cmd; done`
// arrives as three segments — the header, `do cmd`, and `done` — and only the
// middle one names a program.
const KEYWORD_HEADS = new Set(['for', 'while', 'until', 'if', 'elif', 'case'])
const KEYWORD_NOOPS = new Set(['do', 'then', 'else', 'done', 'fi', 'esac', '{', '}', '!', 'time', 'break', 'continue'])
// Read-only by default, but each has flags/subcommands that mutate; the guards
// below reject those before the binary is accepted.
const GUARDED_BINS = {
  // find reads, except for the flags that run or delete things. Anchored to a
  // word boundary so an *argument* containing one of these — a path like
  // `cla119-spike-ok`, or `auto-delete.log` — is not mistaken for the flag.
  find: /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/,
  // journalctl reads logs; these flags delete, rotate or re-key them.
  journalctl: /--(vacuum-\w+|rotate|flush|sync|relinquish-var|setup-keys|update-catalog|header)\b/,
  // systemctl's read-only verbs are handled via SAFE_SUBCOMMANDS.
  // sed prints to stdout unless asked to rewrite the file under it.
  sed: /(^|\s)-[a-zA-Z]*i([a-zA-Z]*)?(\s|=|$)|--in-place\b/,
  // An awk program can open files for writing and shell out. The program text is
  // quoted, so the segment-level redirect check never sees these.
  awk: /print[^|]*>|>>|\bsystem\s*\(|\bclose\s*\(|\|\s*&?\s*"/,
  gawk: /print[^|]*>|>>|\bsystem\s*\(|\bclose\s*\(|\|\s*&?\s*"/,
  // Only ever used here to make a scratch script runnable; the path check in
  // bashIsSafe keeps it inside the sandbox roots.
  chmod: /-R\b|--recursive\b/,
}
// Bins whose non-flag arguments are paths that must land in a sandbox root.
const PATH_ARG_BINS = new Set(['chmod', 'mkdir', 'touch'])
// Run another program rather than doing anything themselves, so the wrapper's
// own name says nothing about what actually executes: `env rm -rf …` must be
// judged on `rm`, not on `env`.
const WRAPPERS = new Set(['env', 'command', 'nohup', 'stdbuf', 'xargs'])
// Like a wrapper, but the program is preceded by a duration: `timeout 180 node …`.
const DURATION_WRAPPERS = new Set(['timeout'])
// Not read-only, but pre-authorised: the Linear CLI only ever touches Sinan's
// own issue tracker, and prompting for every search made the bots unusable.
const PREAPPROVED_BINS = new Set(['linear', 'obsidian'])
// Helper scripts an agent may run unprompted: the CLIs reached the long way
// round (`node /path/to/linear.js …`), and the ones a skill tells it to call.
//
// Matched on the **resolved absolute path**, never the basename. Basename
// matching would be a hole rather than a shortcut: /tmp is writable without a
// prompt, so an agent could write /tmp/room-rename.mjs and run it as itself.
//
// Each entry is a script whose blast radius is known: room-rename.mjs sets
// m.room.name on the room the turn is already in; linear.js reaches Sinan's own
// tracker; ha_helper.py reaches his own Home Assistant. Note the last one both
// reads and writes — a pre-approved ha_helper.py can turn lights and switches
// on and off without asking.
const HOME = process.env.HOME ?? '/home/wunnle'
const PREAPPROVED_SCRIPT_PATHS = new Set([
  `${HOME}/.openclaw/workspace/integrations/linear/linear.js`,
  `${HOME}/.openclaw/workspace/scripts/ha_helper.py`,
  `${HOME}/matrix-pwa/scripts/room-rename.mjs`,
])
// Interpreters that run a *file*. `-c`/`-e` inline code is deliberately not
// covered: the argument has to be one of the paths above.
const SCRIPT_INTERPRETERS = new Set(['node', 'python3', 'python'])
// Programs safe only for specific read-only subcommands.
const SAFE_SUBCOMMANDS = {
  git: new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'describe',
    'blame', 'cat-file', 'shortlog', 'symbolic-ref', 'for-each-ref', 'branch', 'remote',
    'worktree']),
  // install/i/ci run package lifecycle scripts, i.e. arbitrary code, so they are
  // accepted only inside the projects tree (see the npm guard in bashIsSafe).
  npm: new Set(['test', 'ls', 'list', 'outdated', 'view', 'why', 'run', 'install', 'i', 'ci']),
  // --check parses a file and exits; it writes nothing.
  node: new Set(['--version', '-v', '--check', '-c']),
  // Type-checking and linting the checkout. Both only read source (tsc -b can
  // drop a .tsbuildinfo next to it, which stays inside the worktree).
  npx: new Set(['tsc', 'eslint', 'prettier', 'vitest']),
  systemctl: new Set(['status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed',
    'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-jobs',
    'show-environment', 'get-default']),
  hermes: new Set(['status']),
}
const SAFE_NPM_SCRIPTS = new Set(['build', 'test', 'lint', 'typecheck'])
// Git commands that change only the agent's own worktree and the branch it is
// already on. Allowed when the turn is running inside a room worktree: the work
// is on a throwaway branch nobody else has, and the human reviews it at merge
// time. `push` is deliberately absent — that is the step that leaves the Pi.
// Branch and worktree deletion are absent too: refs are shared with the parent
// checkout, so those reach outside this room.
const GIT_WORKTREE_SUBCOMMANDS = new Set(['add', 'commit', 'stash', 'checkout', 'pull', 'fetch',
  'switch', 'restore', 'merge', 'rebase', 'cherry-pick', 'revert', 'tag', 'apply', 'mv'])

// Files that are credentials rather than code. Reading is otherwise unrestricted
// — a turn reads dozens of files and prompting for that would make the room
// unusable — but reading is exactly how a secret leaves, so these few are worth
// a question. The list is the credentials that actually exist on this machine,
// plus the usual shapes.
const SECRET_BASENAMES = new Set([
  'auth.json',          // ~/.codex — ChatGPT tokens, including the refresh token
  '.credentials.json',  // ~/.claude — Claude Code's own OAuth
  '.session.json',      // the bot's Matrix access token
  '.npmrc', '.netrc', '.pgpass',
])
const SECRET_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/,          // .env, .env.local
  /(^|\/)\.ssh\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
]

// True when `target` names one of them. Resolved first, so `../../.ssh/id_rsa`
// and a bare `.env` are judged the same way as an absolute path.
export function isSecretPath(target, cwd) {
  if (!target) return false
  const resolved = path.resolve(cwd ?? '.', String(target).replace(/^~(?=\/|$)/, HOME))
  if (SECRET_BASENAMES.has(path.basename(resolved))) return true
  return SECRET_PATTERNS.some((re) => re.test(resolved))
}

// True when any word of a command names a secret. Deliberately blunt: it does
// not try to work out which argument is a path, because `grep -r foo ~/.ssh`
// and `cat ~/.codex/auth.json` both leak and neither is worth modelling
// precisely. A false positive costs one prompt.
export function commandTouchesSecret(command, cwd) {
  const bare = unquoted(String(command ?? '')).replace(/[|;&<>()]/g, ' ')
  return bare.split(/\s+/).filter(Boolean).some((token) => isSecretPath(token, cwd))
}

// True for paths the agent may write without asking: its own directory, the
// room worktrees, and scratch space.
export function isSandboxPath(target, cwd) {
  // `~/x` is not a relative path — left unexpanded it resolves to `<cwd>/~/x`
  // and every home-directory write would look like a write inside the worktree.
  const home = process.env.HOME ?? '/home/wunnle'
  const resolved = path.resolve(cwd, target.replace(/^~(?=\/|$)/, home))
  return [cwd, ...SCRATCH_ROOTS].some((rootIsh) => {
    const root = path.resolve(rootIsh)
    return resolved === root || resolved.startsWith(root + path.sep)
  })
}

// Splits a command line on unquoted `|`, `||`, `&&`, `;` and newline. A naive
// regex split treats a `|` inside quotes as a pipeline, so `grep "a\|b" f` was
// judged as a call to `grep "a\` and denied — the operator is data there, not
// syntax. Single `&` is deliberately not a separator, so `2>&1` survives.
export function splitSegments(cmd) {
  const segs = []
  let cur = ''
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      cur += c
      // A backslash escapes the next character inside "" but not inside ''.
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i]
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      if ((c === '|' && cmd[i + 1] === '|') || c === '&') i++
      segs.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  segs.push(cur)
  return segs.map((s) => s.trim()).filter(Boolean)
}

// The parts of a segment that are outside quotes — where an operator is syntax
// rather than text. Used so a `>` inside a search pattern is not read as a
// redirect.
export function unquoted(seg) {
  let out = ''
  let quote = null
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < seg.length) i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '\\' && i + 1 < seg.length) { i++; continue }
    out += c
  }
  return out
}

// Removes heredoc bodies, so the prose inside `git commit -F - <<'MSG' … MSG`
// is not split on newlines and judged as a run of unknown commands. The body is
// data for the program in the segment that opened it; that program is still
// checked normally.
export function stripHeredocs(cmd) {
  const lines = cmd.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Matched against the raw line: the delimiter is usually quoted (<<'EOF'),
    // and unquoted() would drop exactly the part that names it.
    const open = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    out.push(line.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g, ''))
    if (!open) continue
    const delim = open[2]
    while (++i < lines.length && lines[i].trim() !== delim) { /* body is data */ }
  }
  return out.join('\n')
}

// Replaces every `$(…)` and backtick substitution with an inert placeholder,
// after checking that the command inside it is itself safe. A blanket reject
// meant `P=$(readlink -f $(which linear))` — pure inspection — needed a human.
// Returns null when any inner command fails, so the caller can deny.
export function resolveSubstitutions(cmd, cwd) {
  if (/<\(|>\(/.test(cmd)) return null   // process substitution: not worth modelling
  let out = ''
  for (let i = 0; i < cmd.length; i++) {
    const isDollar = cmd[i] === '$' && cmd[i + 1] === '('
    if (!isDollar && cmd[i] !== '`') { out += cmd[i]; continue }
    const open = isDollar ? i + 2 : i + 1
    let end = open
    let depth = 1
    while (end < cmd.length && depth > 0) {
      if (isDollar && cmd[end] === '(') depth++
      else if (isDollar && cmd[end] === ')') depth--
      else if (!isDollar && cmd[end] === '`') depth--
      if (depth > 0) end++
    }
    if (depth > 0) return null           // unterminated — cannot reason about it
    if (!bashIsSafe(cmd.slice(open, end), cwd)) return null
    out += 'x'                           // stands in for the captured output
    i = end
  }
  return out
}

// Every write target named by a redirect in the segment. `>/dev/null` and fd
// merges (2>&1) are dropped first; what is left has to land in a sandbox root.
export function redirectTargetsAllowed(seg, cwd) {
  const text = unquoted(seg).replace(/\d*>&\d+/g, '').replace(/[&\d]*>\s*\/dev\/null/g, '')
  const targets = [...text.matchAll(/>>?\s*([^\s>|;&]+)/g)].map((m) => m[1])
  // Any `>` that could not be paired with a target is unexplained — deny.
  const unmatched = text.replace(/>>?\s*[^\s>|;&]+/g, '')
  if (unmatched.includes('>')) return false
  return targets.every((t) => isSandboxPath(t, cwd))
}

export function bashIsSafe(command, cwd) {
  let cmd = (command ?? '').trim()
  if (!cmd) return false
  // Reading is otherwise free, and `cat` is on the allowlist — so without this
  // every credential on the machine could be read with no prompt.
  if (commandTouchesSecret(cmd, cwd)) return false
  if (/(^|\s)sudo(\s|$)/.test(cmd)) return false               // privilege escalation
  cmd = stripHeredocs(cmd)
  // Substitution is checked against the raw string: `$(…)` and backticks still
  // expand inside double quotes, so quoting is no reason to trust them.
  const resolved = resolveSubstitutions(cmd, cwd)
  if (resolved === null) return false
  cmd = resolved
  // A turn runs from its worktree and reaches the projects tree by `cd`ing into
  // it, so the latitude granted there has to follow the `cd` rather than judging
  // every segment against the directory the turn started in.
  let effCwd = cwd
  // Every pipeline/sequence segment must be a recognised read-only program.
  return splitSegments(cmd).every((seg) => {
    if (!redirectTargetsAllowed(seg, cwd)) return false
    let tokens = seg.split(/\s+/)
    // Shell keywords: `done`/`fi` name no program, and a loop or conditional
    // header is judged by its body, which arrives as its own segment.
    while (tokens.length && KEYWORD_NOOPS.has(tokens[0])) tokens = tokens.slice(1)
    if (tokens.length && KEYWORD_HEADS.has(tokens[0])) {
      const at = tokens.findIndex((t) => t === 'do' || t === 'then')
      tokens = at === -1 ? [] : tokens.slice(at + 1)
    }
    if (!tokens.length) return true
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1) // strip VAR=val
    if (!tokens.length) return true      // assignment from an already-checked substitution
    let base = (tokens[0] ?? '').split('/').pop()
    // `cd somewhere && <command>` is judged on the command. The directory itself
    // is not a decision: reads are unrestricted and writes are checked against
    // the sandbox roots by absolute path anyway.
    if (base === 'cd') {
      if (tokens.length === 2) {
        effCwd = path.resolve(effCwd, tokens[1].replace(/^~(?=\/|$)/, HOME))
        return true
      }
      if (tokens.length === 1) return true
      return false                       // `cd` with extra words is not a plain cd
    }
    // Unwrap to the program that really runs. Bail on flags (env -i, -S …)
    // rather than trying to model each wrapper's option grammar.
    while (WRAPPERS.has(base) || DURATION_WRAPPERS.has(base)) {
      const skip = DURATION_WRAPPERS.has(base) ? 2 : 1
      tokens = tokens.slice(skip)
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
      if (!tokens.length || tokens[0].startsWith('-')) return false
      base = tokens[0].split('/').pop()
    }
    if (base === 'curl') return curlIsDeployCheck(tokens)
    if (SAFE_BASH_BINS.has(base) || PREAPPROVED_BINS.has(base)) {
      const binGuard = GUARDED_BINS[base]
      return binGuard ? !binGuard.test(tokens.slice(1).join(' ')) : true
    }
    if (SCRIPT_INTERPRETERS.has(base)) {
      const arg = tokens[1]
      if (arg && !arg.startsWith('-')) {
        const script = path.resolve(cwd, arg.replace(/^~(?=\/|$)/, HOME))
        // Belt and braces: a pre-approved path must not sit anywhere the agent
        // can write unprompted, or the entry becomes a bypass of itself.
        if (PREAPPROVED_SCRIPT_PATHS.has(script) && !isSandboxPath(script, cwd)) return true
      }
    }
    if (PATH_ARG_BINS.has(base)) {
      const guard = GUARDED_BINS[base]
      if (guard && guard.test(tokens.slice(1).join(' '))) return false
      const args = tokens.slice(1).filter((t) => !t.startsWith('-'))
      // chmod's first argument is a mode, not a path.
      const paths = base === 'chmod' ? args.slice(1) : args
      return paths.length > 0 && paths.every((p) => isSandboxPath(p, cwd))
    }
    const guard = GUARDED_BINS[base]
    if (guard) return !guard.test(tokens.slice(1).join(' '))
    const subs = SAFE_SUBCOMMANDS[base]
    if (!subs) return false
    // The subcommand is the first non-flag word — `systemctl --user status` used
    // to be judged on `--user` and so always asked. Flags that are themselves
    // the subcommand (`node --check`) still match.
    let at = 1
    while (at < tokens.length && tokens[at].startsWith('-') && !subs.has(tokens[at])) at++
    const sub = tokens[at]
    if (base === 'git' && GIT_WORKTREE_SUBCOMMANDS.has(sub)) return gitStaysInWorktree(tokens, effCwd) || inProjects(effCwd)
    // `push` still leaves the Pi, so it stays out of the worktree set above. In
    // the projects tree it is the whole point — the push *is* the deploy — and
    // the only thing reachable is a repo Sinan treats as disposable.
    if (base === 'git' && sub === 'push') return inProjects(effCwd)
    if (!subs.has(sub)) return false
    if (base === 'npm' && sub === 'run') return SAFE_NPM_SCRIPTS.has(tokens[at + 1])
    if (base === 'npm' && (sub === 'install' || sub === 'i' || sub === 'ci')) return inProjects(effCwd)
    // `git branch`/`git remote` list only with no extra args (branch -d, remote add mutate).
    if (base === 'git' && (sub === 'branch' || sub === 'remote')) return tokens.length === at + 1
    // `git worktree` also adds, moves and prunes; only the listing is read-only.
    if (base === 'git' && sub === 'worktree') return tokens[at + 1] === 'list'
    return true
  })
}

// A git write is pre-approved only when it acts on the room's own worktree: the
// turn has to be running inside one, and `-C <path>` must not point out of it.
export function gitStaysInWorktree(tokens, cwd) {
  const root = path.resolve(WORKTREES_ROOT)
  const here = path.resolve(cwd)
  if (here !== root && !here.startsWith(root + path.sep)) return false
  const at = tokens.indexOf('-C')
  if (at !== -1) {
    const target = tokens[at + 1]
    if (!target) return false
    const dir = path.resolve(cwd, target.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
    if (dir !== root && !dir.startsWith(root + path.sep)) return false
  }
  return true
}
