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

// A plain GET is a read of the public internet, and `WebFetch` — which is in
// AUTO_ALLOW, unrestricted, any URL — already does exactly that. Holding curl to
// one allowlisted host while the more capable tool asks nobody was an
// inconsistency rather than a boundary: it only pushed the agent towards the
// tool with less scrutiny. So the host check is gone and the *method* check is
// what remains. Anything that sends a body, changes the method, uploads, or
// saves the response outside the sandbox still asks — `curl … | sh` is the shape
// this hook exists to stop, and that is caught by `sh` being an unknown program
// in the next segment, not by the URL.
// HEAD is a GET without the body, and `curl -I` already sends one unasked.
// The `(?!\s|…)` stops `\s*` backtracking to zero spaces, where the lookahead
// would see " GET" and so never match the exemption.
const HTTP_MUTATES = /(^|\s)(-X\s*(?!\s|(GET|HEAD)\b)|--request\s+(?!\s|(GET|HEAD)\b)|-d\b|--data\S*|-F\b|--form\b|-T\b|--upload-file\b|--config\b|-K\b|--post\S*|--method\s+(?!\s|(GET|HEAD)\b))/
// Where a download may land: discarded, stdout, or inside a sandbox root.
function outputTargetOk(target, effCwd, cwd) {
  if (!target) return false
  const t = target.replace(/^['"]|['"]$/g, '')
  return t === '/dev/null' || t === '-' || isSandboxPathFrom(t, effCwd, cwd)
}
function httpIsRead(tokens, effCwd, cwd) {
  const args = tokens.slice(1)
  if (HTTP_MUTATES.test(args.join(' '))) return false
  // -O/--remote-name writes a file named by the server into the working
  // directory. Predictable only when that directory is a sandbox root.
  if (args.some((a) => a === '-O' || a === '--remote-name')) {
    if (!isSandboxPathFrom('.', effCwd, cwd)) return false
  }
  for (let i = 0; i < args.length; i++) {
    if (['-o', '--output', '--output-document'].includes(args[i]) && !outputTargetOk(args[i + 1], effCwd, cwd)) return false
  }
  // wget writes to the current directory unless told otherwise, so it needs an
  // explicit destination — curl prints to stdout and needs none.
  if (tokens[0].split('/').pop() === 'wget') {
    const at = args.findIndex((a) => a === '-O' || a === '--output-document')
    if (at === -1 ? !isSandboxPathFrom('.', effCwd, cwd) : !outputTargetOk(args[at + 1], effCwd, cwd)) return false
  }
  // No URL at all is not a fetch — it is some other use of the tool.
  return args.some((t) => /^['"]?[a-z]+:\/\//i.test(t))
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

// Claude's Artifact tool publishes a page to Sinan's own claude.ai account,
// private until he shares it, and rooms are told to use it freely; a tap per
// publish would undo that. Still asked: delete (permanent, for everyone with
// the link), `force` (throws away a newer version someone saved), a page that
// asks for runtime capabilities (live data, devices, Claude calls), and any
// file that looks like a credential. ArtifactComments and ArtifactData are not
// covered: they write where other people read.
const ARTIFACT_FREE_ACTIONS = new Set(['publish', 'read', 'list', 'open', 'quickstart', 'pin', 'unpin'])
export function artifactIsSafe(input, cwd) {
  const action = input?.action ?? 'publish'
  if (!ARTIFACT_FREE_ACTIONS.has(action)) return false
  if (input.force) return false
  if (input.capabilities && Object.keys(input.capabilities).length > 0) return false
  const sources = [input.file_path, ...(Array.isArray(input.file_paths) ? input.file_paths : [])]
  const files = input.files
  if (Array.isArray(files)) sources.push(...files.map((f) => f?.path))
  else if (files && typeof files === 'object') {
    for (const v of Object.values(files)) sources.push(typeof v === 'string' ? v : v?.from)
  }
  return !sources.some((s) => typeof s === 'string' && isSecretPath(s, cwd))
}

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
// …except these, whose header *is* a command: `until git push; do` runs the
// push. Treating the header as a no-op let any command through as a condition.
const CONDITION_HEADS = new Set(['while', 'until', 'if', 'elif'])
const KEYWORD_NOOPS = new Set(['do', 'then', 'else', 'done', 'fi', 'esac', '{', '}', '!', 'time', 'break', 'continue'])

// The words of a segment with the shell keywords peeled off, leaving the
// command that actually runs (or nothing, for `done` or a `for … in` header).
function stripKeywords(tokens) {
  while (tokens.length && KEYWORD_NOOPS.has(tokens[0])) tokens = tokens.slice(1)
  if (tokens.length && KEYWORD_HEADS.has(tokens[0])) {
    const at = tokens.findIndex((t) => t === 'do' || t === 'then')
    if (at !== -1) tokens = tokens.slice(at + 1)
    else tokens = CONDITION_HEADS.has(tokens[0]) ? tokens.slice(1) : []
    while (tokens.length && KEYWORD_NOOPS.has(tokens[0])) tokens = tokens.slice(1)
  }
  return tokens
}
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
const PATH_ARG_BINS = new Set(['chmod', 'mkdir', 'touch', 'cp', 'ln'])
// For these only the destination is written; the sources are reads, and reading
// is unrestricted. `mv` is deliberately not here — it deletes its source too.
// `ln`'s source is only a name the link points at — `ln -s ~/matrix-pwa/
// node_modules node_modules` is how a worktree gets its dependencies. A link
// that points at a secret is still caught when something reads through it.
const DEST_ONLY_BINS = new Set(['cp', 'ln'])
// Run another program rather than doing anything themselves, so the wrapper's
// own name says nothing about what actually executes: `env rm -rf …` must be
// judged on `rm`, not on `env`.
const WRAPPERS = new Set(['env', 'command', 'nohup', 'stdbuf', 'xargs'])
// Like a wrapper, but the program is preceded by a duration: `timeout 180 node …`.
const DURATION_WRAPPERS = new Set(['timeout'])
// Not read-only, but pre-authorised: the Linear CLI only ever touches Sinan's
// own issue tracker, and prompting for every search made the bots unusable.
const PREAPPROVED_BINS = new Set(['linear', 'obsidian'])
// Sinan's own one-liner wrappers in ~/.local/bin. They exist *because* a
// compound command cannot be allowlisted, so making the agent ask for them
// defeats the reason they were written.
//
// Matched only when invoked as a bare name — no slash — so the shell resolves
// them through PATH to ~/.local/bin. A path token would be a bypass: /tmp is
// writable without a prompt, so `/tmp/wait-for` must not inherit this.
//
// `linear-gql` is here for a reason worth spelling out: prompting for it was
// making the tracker *less* safe, not more. The `linear` CLI has no project
// support, so a room that needs one reaches around it — and with the wrapper
// gated, the cheaper route was reading LINEAR_API_KEY out of .env inline and
// POSTing by hand, or writing a throwaway client in /tmp. Both prompt too, and
// both put the credential in the command line. linear-gql keeps the key inside
// itself. It reaches the same API as the already-pre-approved `linear`; raw
// mutations do go further than the CLI's verbs, which is the cost of closing
// the gap agents were routing around anyway.
// `page` drives a real headless Chromium (shot/text/dom/eval/errors). It is the
// widest of these by far — it fetches any URL and runs JS on it — and it is
// here anyway, for two reasons. WebFetch is already in AUTO_ALLOW for any URL,
// so the fetching half asks nobody today; and the browser it drives keeps its
// own throwaway profile in /tmp, logged out, so a page cannot act as Sinan.
// Driving a browser was the single worst category in the approval audit: 74% of
// browser-shaped calls prompted, against 51% overall, and a third of them were
// nothing but starting a browser or picking a port.
// `construct-activity` puts a Live Activity on Sinan's lock screen. That is the
// whole point of it, and a prompt asking whether to notify him would itself
// notify him. Its reach is his own phone and a message into a room he owns; the
// server caps it at three activities and rate-limits updates.
// `construct-browse` posts a page card into the agent's own room, and
// `construct-preview` puts a local port on Sinan's private tailnet with
// `tailscale serve` (never Funnel, so never the public internet) and opens it.
const HELPER_BINS = new Set(['wait-for', 'page-grep', 'page', 'linear-gql', 'construct-activity', 'construct-browse', 'construct-preview'])
function isHelperBin(token) {
  return !token.includes('/') && HELPER_BINS.has(token)
}
// `construct-preview <port> … -- <command>` also starts the dev server, as a
// user service: it is a wrapper then, and what it runs is judged on its own
// (`construct-preview 5173 -- rm -rf ~` must be judged on `rm`). Returns the
// command after `--`, or the tokens unchanged when there is none.
function previewCommand(tokens) {
  if (tokens[0] !== 'construct-preview') return tokens
  const i = tokens.indexOf('--')
  return i < 0 ? tokens : tokens.slice(i + 1)
}
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
// on and off without asking. send-image.mjs posts an image file into the room
// the turn is in, the same reach as room-rename.mjs; it was a tap per
// screenshot. agent-review/session.mjs only reads a Hermes state.db, opened
// read-only; the weekly reviewer opens every flagged conversation with it.
const HOME = process.env.HOME ?? '/home/wunnle'
const PREAPPROVED_SCRIPT_PATHS = new Set([
  `${HOME}/.openclaw/workspace/integrations/linear/linear.js`,
  `${HOME}/.openclaw/workspace/scripts/ha_helper.py`,
  `${HOME}/matrix-pwa/scripts/room-rename.mjs`,
  `${HOME}/matrix-pwa/scripts/send-image.mjs`,
  `${HOME}/matrix-pwa/scripts/agent-review/session.mjs`,
])

// A headless Chromium that renders a page and exits: the screenshot half of the
// CSS loop. Its only writes are the flags below, so each must land in a sandbox
// root. A debugging port is refused — that leaves a browser running for anyone
// to drive, and 9222 already belongs to Hermes.
const CHROMIUM_BINS = new Set(['chromium', 'chromium-browser', 'google-chrome', 'chrome'])
const CHROMIUM_WRITE_FLAGS = ['--screenshot', '--print-to-pdf', '--user-data-dir', '--crash-dumps-dir']
function chromiumIsRender(tokens, effCwd, cwd) {
  const args = tokens.slice(1).map((a) => a.replace(/^['"]|['"]$/g, ''))
  if (!args.some((a) => a === '--headless' || a.startsWith('--headless='))) return false
  if (args.some((a) => /^--remote-debugging-(port|pipe|address)\b/.test(a))) return false
  for (const flag of CHROMIUM_WRITE_FLAGS) {
    for (const a of args) {
      if (a === flag) {
        // Bare --screenshot/--print-to-pdf write into the working directory.
        if (!isSandboxPathFrom('.', effCwd, cwd)) return false
      } else if (a.startsWith(`${flag}=`)) {
        if (!isSandboxPathFrom(a.slice(flag.length + 1), effCwd, cwd)) return false
      }
    }
  }
  return true
}
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
  // .env, .env.local — but not the committed templates, which hold no values.
  /(^|\/)\.env(\.(?!(example|sample|template)$)[^/]*)?$/,
  // The directory itself counts, not just a file inside it: `grep -r token
  // ~/.ssh` names no file and leaked every key past a `\.ssh/` pattern.
  // Unanchored on purpose, so `$OTHER/.ssh` and another user's home count too.
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.config\/gh(\/|$)/,
  // Hermes keeps its keys in .env files (caught above), auth.json (caught
  // below) and these three directories: OAuth clients and tokens, the OAuth
  // session state, and backups of all of the above. The rest of ~/.hermes is
  // scripts, skills, logs and room config that agents read constantly, and
  // counting the whole tree as a secret made every Hermes job a run of taps.
  /(^|\/)\.hermes\/(credentials|state|backups)(\/|$)/,
  // auth.json and its backups (auth.json.bak-…), in ~/.codex and every Hermes profile.
  /(^|\/)auth\.json(\.[^/]*)?$/,
  // The bot's Matrix session, in every checkout and worktree. Its bot.log is
  // the one file left out: it is the only log on this Pi, agents debugging the
  // bot read it constantly, and a scan found no tokens in it — what it records
  // was already posted in a room. The directory itself still counts, so a
  // recursive search of it asks.
  /(^|\/)\.claude-bot-store(\/(?!bot\.log$)|$)/,
  // ~/.vercel-bender-token and any sibling token file.
  new RegExp(`^${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.vercel[^/]*(/|$)`),
  // Another process's environment — the bot's holds its tokens.
  /^\/proc\/[^/]+\/environ$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
]

// `~`, `$HOME` and `${HOME}` all mean the same directory to the shell.
function expandHome(p) {
  return String(p).replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME)
}

// The shell expands `{a,b}` before anything looks at the disk, so
// `~/.s{s,}h/id_rsa` is `~/.ssh/id_rsa` by the time `cat` sees it. Past a few
// groups the alternatives are not worth enumerating: each group becomes a `*`
// and the glob check below judges it.
function expandBraces(word) {
  const groups = [...word.matchAll(/\{([^{}]*)\}/g)].filter((m) => m[1].includes(','))
  if (!groups.length) return [word]
  if (groups.length > 4) return [word.replace(/\{[^{}]*\}/g, '*')]
  const m = groups[0]
  return m[1].split(',').flatMap((alt) => expandBraces(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length)))
}

// A shell glob as a regex. `*`, `?` and `**` do not match a leading dot, as in
// bash — otherwise every `cat *` in a worktree would count as reading its .env.
const GLOB_CHARS = /[*?[]/
function globToRegex(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    const noDot = i === 0 || glob[i - 1] === '/' ? '(?!\\.)' : ''
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') { i++; re += '(?:(?!\\.)[^/]*/)*' } else re += '(?:(?!\\.)[^/]*/?)*'
    } else if (c === '*') re += `${noDot}[^/]*`
    else if (c === '?') re += `${noDot}[^/]`
    else if (c === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2)
      re += `${noDot}[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
      i = end
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  try { return new RegExp(`^${re}$`) } catch { return null }
}
// A glob cannot be matched against the disk without I/O, so it is matched
// against where the secrets are: the fixed ones in $HOME, and the ones that can
// sit in any directory, placed under the glob's own literal prefix.
const HOME_SECRET_PROBES = ['.hermes/.env', '.hermes/profiles/p/.env', '.hermes/auth.json',
  '.hermes/profiles/p/auth.json', '.hermes/credentials/c.json', '.hermes/state/s', '.ssh/id_rsa','.ssh/id_ed25519',
  '.gnupg/k', '.aws/credentials', '.config/gh/hosts.yml', '.netrc', '.vercel-bender-token',
  '.codex/auth.json', '.claude/.credentials.json', '.npmrc', '.pgpass'].map((p) => `${HOME}/${p}`)
const LOCAL_SECRET_PROBES = ['.env', '.env.local', 'x/.env', '.claude-bot-store/s.json',
  'scripts/.claude-bot-store/s.json', 'x/scripts/.claude-bot-store/s.json', '.session.json',
  '.credentials.json', '.npmrc', '.netrc']
function globMayBeSecret(glob) {
  const dir = glob.slice(0, glob.search(GLOB_CHARS)).replace(/[^/]*$/, '')
  const probes = [...HOME_SECRET_PROBES, ...LOCAL_SECRET_PROBES.map((p) => dir + p)]
  // Every secret probe and every secret directory above one, so `~/.s?h/x`
  // counts by the directory it reaches into even though no probe is named x.
  const targets = new Set()
  for (const p of probes) {
    for (let at = p.length; at > 0; at = p.lastIndexOf('/', at - 1)) {
      const candidate = p.slice(0, at)
      if (literalIsSecret(candidate)) targets.add(candidate)
    }
  }
  const segs = glob.split('/')
  for (let k = 2; k <= segs.length; k++) {
    const re = globToRegex(segs.slice(0, k).join('/'))
    // A word that will not translate is almost always a quoted jq or JS
    // program, not a path — and a bracket the shell cannot parse matches no
    // file either, so the word reaches the reader literally, where the literal
    // check above has already judged it.
    if (!re) return false
    for (const t of targets) if (re.test(t)) return true
  }
  return false
}

function literalIsSecret(resolved) {
  if (SECRET_BASENAMES.has(path.basename(resolved))) return true
  return SECRET_PATTERNS.some((re) => re.test(resolved))
}

// True when `target` names one of them. Resolved first, so `../../.ssh/id_rsa`
// and a bare `.env` are judged the same way as an absolute path.
export function isSecretPath(target, cwd) {
  if (!target) return false
  return expandBraces(expandHome(target)).some((one) => {
    const resolved = path.resolve(cwd ?? '.', expandHome(one))
    return literalIsSecret(resolved) || (GLOB_CHARS.test(resolved) && globMayBeSecret(resolved))
  })
}

// True for $HOME, every directory above it, and every directory that holds one
// of the fixed secrets (~/.hermes, ~/.hermes/profiles/x). Nothing there is a
// secret by itself, but a recursive search from one walks into them.
export function containsHomeSecrets(target, cwd) {
  const resolved = path.resolve(cwd ?? '.', expandHome(target))
  if (resolved === HOME || HOME.startsWith(resolved === '/' ? '/' : `${resolved}/`)) return true
  const profile = /^(.*\/\.hermes\/profiles)\/[^/]+$/.exec(resolved)
  return HOME_SECRET_PROBES.some((p) => p.startsWith(`${resolved}/`))
    || Boolean(profile && profile[1] === `${HOME}/.hermes/profiles`)
}

// Writes outside the sandbox that Sinan has approved standing: the Bender
// notes in the vault, Hermes skills, scripts and room config, and Claude's own
// memory. Each is text that agents are told to keep current, and a tap per
// edit was the most common card in the approval log.
const PREAPPROVED_WRITES = [
  `${HOME}/Documents/Obsidian/Bender/`,
  `${HOME}/.hermes/skills/`,
  `${HOME}/.hermes/scripts/`,
  /^\.hermes\/profiles\/[^/]+\/skills\//,
  /^\.hermes\/(profiles\/[^/]+\/)?rooms\.yaml$/,
  /^\.claude\/projects\/[^/]+\/memory\//,
]
export function isPreapprovedWrite(target, cwd) {
  if (!target || isSecretPath(target, cwd)) return false
  const resolved = path.resolve(cwd ?? '.', expandHome(target))
  const rel = resolved.startsWith(`${HOME}/`) ? resolved.slice(HOME.length + 1) : null
  return PREAPPROVED_WRITES.some((p) => (typeof p === 'string' ? resolved.startsWith(p) : rel !== null && p.test(rel)))
}

// Symlinks need the filesystem, so the caller lends its realpath and the rules
// stay pure. Only literal paths are followed; a glob has no single target.
export function linksToSecret(targets, cwd, realpath) {
  return targets.some((t) => {
    if (!t || GLOB_CHARS.test(t)) return false
    const named = path.resolve(cwd ?? '.', expandHome(t))
    let real
    try { real = realpath(named) } catch { return false }
    // A link to a directory that holds secrets is a way for a search to walk
    // into them; reading the directory itself would be harmless, so the cost
    // of counting it is one prompt. Only for a link: naming ~ directly is
    // already judged by the recursive-search rules.
    return isSecretPath(real, '/') || (real !== named && containsHomeSecrets(real, '/'))
  })
}

// The words of a command the way the program will receive them: quotes and
// backslashes removed, not the quoted text dropped. Dropping it — what
// unquoted() does, rightly, for operators — let `cat "/home/x/.ssh/id_rsa"`
// through. The part after any `=` or `:` is a word too, for `--file=~/.netrc`,
// `KEY=~/.ssh/x` and `git show HEAD:.env`.
export function commandWords(command) {
  const s = String(command ?? '')
  const words = []
  let cur = ''
  let started = false
  let quote = null
  const push = () => { if (started) words.push(cur); cur = ''; started = false }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; started = true; continue }
    if (/[\s|;&<>()`]/.test(c)) { push(); continue }
    cur += c
    started = true
  }
  push()
  return words.flatMap((w) => [w, ...[...w.matchAll(/[=:]/g)].map((m) => w.slice(m.index + 1))]).filter(Boolean)
}

// Searches that read every file under the paths they are given.
const RECURSIVE_READERS = new Set(['rg', 'ag', 'ack'])
const GREP_BINS = new Set(['grep', 'egrep', 'fgrep'])
function recursesFromHome(words, effCwd) {
  const at = words.findIndex((w) => {
    const base = w.split('/').pop()
    return RECURSIVE_READERS.has(base) || (GREP_BINS.has(base)
      && words.some((f) => /^-[a-zA-Z]*[rR][a-zA-Z]*$|^--(dereference-)?recursive$|^--directories=recurse$/.test(f)))
  })
  if (at === -1) return false
  const args = words.slice(at + 1).filter((w) => !w.startsWith('-'))
  // With only a pattern, the search starts where the command runs.
  if (args.length < 2 && containsHomeSecrets('.', effCwd)) return true
  return args.some((a) => containsHomeSecrets(a, effCwd))
}

// True when any word of a command names a secret. Deliberately blunt: it does
// not try to work out which argument is a path, because `grep -r foo ~/.ssh`
// and `cat ~/.codex/auth.json` both leak and neither is worth modelling
// precisely. A false positive costs one prompt. A `cd` moves where later
// relative words resolve, so `cd ~/.config && cat gh/hosts.yml` counts.
export function commandTouchesSecret(command, cwd) {
  let effCwd = cwd ?? '.'
  return splitSegments(stripHeredocs(String(command ?? ''))).some((seg) => {
    const all = commandWords(seg)
    // Before the keywords come off: a `for f in ~/.ssh/*` header names no
    // program, but its words are what the loop body reads.
    if (all.some((w) => isSecretPath(w, effCwd))) return true
    const words = stripKeywords(all)
    if (words[0] === 'cd' && words.length <= 2) {
      effCwd = path.resolve(effCwd, expandHome(words[1] ?? '~'))
      return false
    }
    return recursesFromHome(words, effCwd)
  })
}

// Read-only tools whose target is a secret, judged on every field that names
// a path: a Glob's pattern is joined onto its directory, a Grep's file filter
// likewise, and a Grep rooted at $HOME or above walks into all of them.
export function toolReadsSecret(toolName, input, cwd) {
  const dir = cwd ?? '.'
  const i = input ?? {}
  if (toolName === 'Glob' || toolName === 'Grep') {
    const root = path.resolve(dir, expandHome(i.path ?? '.'))
    if (isSecretPath(root, dir)) return true
    const filter = toolName === 'Glob' ? i.pattern : i.glob
    if (filter && isSecretPath(path.resolve(root, expandHome(filter)), dir)) return true
    return toolName === 'Grep' && containsHomeSecrets(root, dir)
  }
  return isSecretPath(i.file_path ?? i.notebook_path ?? i.path, dir)
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

// isSandboxPath treats the cwd it is given as a root of its own, so handing it
// `effCwd` after a `cd` answers "is this inside the directory we just cd'd
// into" — always yes, which quietly allowed `cd ~/.hermes && mkdir x`. Relative
// paths must resolve against where the command actually runs while still being
// judged against the roots of the directory the *turn* started in.
export function isSandboxPathFrom(target, effCwd, cwd) {
  const resolved = path.resolve(effCwd, String(target).replace(/^~(?=\/|$)/, HOME))
  return isSandboxPath(resolved, cwd)
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
    // Shell keywords: `done`/`fi` name no program, a `for` header names none
    // either, and a `while`/`until`/`if` header is judged as the command it runs.
    let tokens = stripKeywords(seg.split(/\s+/))
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
    if (previewCommand(tokens) !== tokens) {
      tokens = previewCommand(tokens)
      if (!tokens.length) return false
      base = tokens[0].split('/').pop()
    }
    while (WRAPPERS.has(base) || DURATION_WRAPPERS.has(base)) {
      const skip = DURATION_WRAPPERS.has(base) ? 2 : 1
      tokens = tokens.slice(skip)
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
      if (!tokens.length || tokens[0].startsWith('-')) return false
      base = tokens[0].split('/').pop()
    }
    if (base === 'curl' || base === 'wget') return httpIsRead(tokens, effCwd, cwd)
    if (CHROMIUM_BINS.has(base)) return chromiumIsRender(tokens, effCwd, cwd)
    if (isHelperBin(tokens[0])) return true
    if (SAFE_BASH_BINS.has(base) || PREAPPROVED_BINS.has(base)) {
      const binGuard = GUARDED_BINS[base]
      return binGuard ? !binGuard.test(tokens.slice(1).join(' ')) : true
    }
    // Standing up a Python environment inside the sandbox, the counterpart of
    // the `npm install` latitude below. Both run third-party setup code, so both
    // are scoped to a directory whose contents are disposable — a venv is a
    // directory you throw away, and asking about every `pip install -r` made
    // Python work in a room cost a tap per dependency.
    if ((base === 'python3' || base === 'python') && tokens[1] === '-m' && tokens[2] === 'venv') {
      const target = tokens.slice(3).find((t) => !t.startsWith('-'))
      return Boolean(target) && isSandboxPathFrom(target, effCwd, cwd)
    }
    if (base === 'pip' || base === 'pip3') {
      const sub = tokens.slice(1).find((t) => !t.startsWith('-'))
      if (['list', 'show', 'freeze', 'check'].includes(sub)) return true
      if (sub === 'install' || sub === 'download') return isSandboxPathFrom('.', effCwd, cwd)
      return false
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
      const paths = base === 'chmod' ? args.slice(1)
        : DEST_ONLY_BINS.has(base) ? args.slice(-1)
        : args
      // A copy with only one argument names no destination; judge it as unknown
      // rather than treating the source as the thing being written.
      if (DEST_ONLY_BINS.has(base) && args.length < 2) return false
      return paths.length > 0 && paths.every((p) => isSandboxPathFrom(p, effCwd, cwd))
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

// ---------------------------------------------------------------------------
// Auto mode: the few things that still ask even when the human has stood down.
//
// `!auto on` makes a room approve its own tool calls. That is a deliberate
// loosening, not a blank cheque: the calls below are the ones whose damage is
// not contained by the room's worktree — they escalate privilege, leave the
// machine, publish, or touch something outside the sandbox roots. Those keep
// their card. Everything else the hook would have asked about is allowed and
// merely reported.
//
// Note the asymmetry with bashIsSafe: that function decides whether to ask at
// all and errs towards asking, so anything reaching here is already unsafe by
// its lights. This one only decides whether auto mode may answer for Sinan, so
// it errs towards keeping the human — an unrecognised command is auto-approved
// (it was judged worth a prompt, not worth a veto), but an unrecognised *shape*
// of danger is exactly what the explicit lists below are for.
const NEVER_AUTO_BINS = new Set([
  // Privilege escalation — the worktree stops mattering the moment these run.
  'sudo', 'doas', 'su', 'pkexec',
  // The machine itself. A Pi that reboots mid-turn cannot be asked about it.
  // (`systemctl --user` is judged separately below.)
  'shutdown', 'reboot', 'poweroff', 'halt', 'mkfs', 'fdisk', 'dd',
  // Leaving this machine: publishing, deploying, or reaching another host.
  // (`gh`'s read-only verbs are judged separately below.)
  'ssh', 'scp', 'rsync', 'vercel',
])
// Bins that destroy or relocate whatever they are pointed at. Allowed under auto
// mode only while every path argument stays in a sandbox root.
const PATH_DESTRUCTIVE_BINS = new Set(['rm', 'rmdir', 'mv', 'truncate'])
// Bins that create or change files without destroying a source. Under auto mode
// they may write wherever an Edit may (see autoMayWrite).
const PATH_WRITE_BINS = new Set(['cp', 'chmod', 'chown', 'ln', 'install'])

// The user's own services are this Pi's apps — dev previews, Hermes gateways,
// timers — and restarting one is the routine last step of changing it. Only the
// user manager is reachable without sudo, which auto mode never answers. The bot
// itself is the exception: restarting it cuts off every room's turn at once.
const SYSTEMCTL_POWER_VERBS = new Set(['poweroff', 'reboot', 'halt', 'kexec', 'suspend', 'hibernate', 'exit', 'soft-reboot'])
function systemctlVeto(tokens) {
  if (!tokens.includes('--user')) return '`systemctl` without --user reaches the whole machine'
  if (tokens.some((t) => SYSTEMCTL_POWER_VERBS.has(t))) return '`systemctl` would power off or exit the session'
  if (tokens.some((t) => /^claude-code-bot(\.service)?$/.test(t))
    && !tokens.some((t) => SAFE_SUBCOMMANDS.systemctl.has(t))) return 'restarting the bot cuts off every room'
  return null
}

// Reading GitHub is the same class of act as a curl GET, which auto mode
// already answers. Creating, editing, merging or downloading still asks.
const GH_READS = {
  repo: ['view', 'list'], release: ['view', 'list'], pr: ['view', 'list', 'diff', 'checks', 'status'],
  issue: ['view', 'list', 'status'], run: ['view', 'list'], workflow: ['view', 'list'], gist: ['view', 'list'],
  search: null, browse: null, status: null,
}
function ghIsRead(tokens) {
  const words = tokens.slice(1).filter((t) => !t.startsWith('-'))
  if (words[0] === 'api') {
    return !/(^|\s)(-X\s*(?!GET\b)|--method\s+(?!GET\b)|-f\b|-F\b|--field\b|--raw-field\b|--input\b)/.test(tokens.slice(1).join(' '))
  }
  if (!(words[0] in GH_READS)) return false
  const verbs = GH_READS[words[0]]
  return verbs === null || verbs.includes(words[1])
}

// Under auto mode a write may leave the sandbox for anywhere in $HOME, except
// the few files whose change outlives the room in a way nobody would review:
// Claude's own settings, shell startup files, Hermes' model config, the
// approval gate itself, and the helpers it lets run unprompted.
const AUTO_PROTECTED_WRITES = [
  /^\.claude\/(?!projects\/[^/]+\/memory\/)/,
  /^\.[^/]+$/,                                   // ~/.bashrc, ~/.profile, ~/.gitconfig
  /^\.hermes\/(profiles\/[^/]+\/)?config\.yaml$/,
  /^matrix-pwa\/scripts\/(approval-rules|claude-approval-hook|approval-queue)\.mjs$/,
  /^\.config\/systemd\/user\/claude-code-bot\.service$/,
]
function autoMayWrite(target, cwd) {
  if (!target) return false
  if (isSandboxPath(target, cwd)) return true
  if (isSecretPath(target, cwd)) return false
  const resolved = path.resolve(cwd ?? '.', expandHome(target))
  if (!resolved.startsWith(`${HOME}/`)) return false
  const rel = resolved.slice(HOME.length + 1)
  if (rel.startsWith('.local/bin/') && HELPER_BINS.has(rel.slice('.local/bin/'.length))) return false
  if (PREAPPROVED_SCRIPT_PATHS.has(resolved)) return false
  return !AUTO_PROTECTED_WRITES.some((re) => re.test(rel))
}

// The file a write tool's summary names on its first line (`# edit <path>`),
// for callers that did not send the target on its own.
function summaryTarget(summary) {
  const first = String(summary ?? '').split('\n')[0]
  return /^# (?:edit|write|notebook \S+) (.+?)(?: \(all occurrences\)| \(cell .*\))?$/.exec(first)?.[1]
}

// The program a segment really runs, or null when it names none. Same unwrapping
// bashIsSafe does — keywords, VAR=val assignments, wrappers — kept separate
// because that function answers a different question and returns a boolean.
function segmentHead(seg) {
  let tokens = stripKeywords(unquoted(seg).trim().split(/\s+/).filter(Boolean))
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
  if (!tokens.length) return null
  tokens = previewCommand(tokens)
  if (!tokens.length) return { base: null, tokens }
  let base = tokens[0].split('/').pop()
  while (WRAPPERS.has(base) || DURATION_WRAPPERS.has(base)) {
    tokens = tokens.slice(DURATION_WRAPPERS.has(base) ? 2 : 1)
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
    // A flagged wrapper (`env -i …`) hides what runs; say so rather than guess.
    if (!tokens.length || tokens[0].startsWith('-')) return { base: null, tokens }
    base = tokens[0].split('/').pop()
  }
  return { base, tokens }
}

// Why this call still needs a human despite auto mode, or null if it does not.
// The string is shown in the room, so it reads as a reason and not a code.
export function requiresHuman({ toolName, summary, cwd, input, target } = {}) {
  const dir = cwd ?? '.'
  // A write is judged on the file it names, never on the text it writes: a
  // note that merely *mentions* ~/.hermes/.env is not a write to it.
  if (PATH_SCOPED.has(toolName)) {
    const file = target ?? summaryTarget(summary)
    if (file && isSecretPath(file, dir)) return 'it writes to a secret file'
    return autoMayWrite(file, dir) ? null : 'it writes to a protected file or outside your home directory'
  }

  // Credentials first, and for every tool: a secret leaving is the one mistake
  // that cannot be undone by throwing the worktree away. The read tools are
  // judged on their input where the caller sends it, since a Glob's summary
  // does not carry its pattern.
  if (AUTO_ALLOW.has(toolName) && input && toolReadsSecret(toolName, input, dir)) return 'it reads a secret file'
  if (commandTouchesSecret(summary ?? '', dir)) return 'it reads a secret file'

  if (toolName !== 'Bash') return null

  const cmd = stripHeredocs(String(summary ?? ''))
  for (const seg of splitSegments(cmd)) {
    const text = unquoted(seg).replace(/\d*>&\d+/g, '').replace(/[&\d]*>\s*\/dev\/null/g, '')
    const redirects = [...text.matchAll(/>>?\s*([^\s>|;&]+)/g)].map((m) => m[1])
    if (text.replace(/>>?\s*[^\s>|;&]+/g, '').includes('>') || !redirects.every((t) => autoMayWrite(t, dir))) {
      return 'it redirects output to a protected file or outside your home directory'
    }
    const head = segmentHead(seg)
    if (!head) continue
    const { base, tokens } = head
    if (!base) return 'the wrapper hides which program runs'
    if (NEVER_AUTO_BINS.has(base)) return `\`${base}\` reaches outside this room`
    if (base === 'systemctl') {
      const veto = systemctlVeto(tokens)
      if (veto) return veto
    }
    if (base === 'gh' && !ghIsRead(tokens)) return '`gh` would change something on GitHub'
    // `git push` is the step that leaves the Pi. Everything else git does is
    // either already allowed without asking or confined to the branch.
    if (base === 'git' && tokens.slice(1).some((t) => t === 'push')) return 'it pushes to a remote'
    if (base === 'npm' && tokens[1] === 'publish') return 'it publishes a package'
    // A plain GET is a read and auto mode may answer it; a request that carries
    // a body is data leaving the machine, which is the same class as a push.
    if ((base === 'curl' || base === 'wget') && !httpIsRead(tokens, dir, dir)) return 'it sends data off this machine'
    if (PATH_DESTRUCTIVE_BINS.has(base)) {
      // `mv` is judged on every argument because it deletes its source too.
      const paths = tokens.slice(1).filter((t) => !t.startsWith('-'))
      if (!paths.length || !paths.every((p) => isSandboxPath(p, dir))) {
        return `\`${base}\` is pointed outside the worktree`
      }
    }
    if (PATH_WRITE_BINS.has(base)) {
      const args = tokens.slice(1).filter((t) => !t.startsWith('-'))
      // Only the destination is written by a copy or a link, and reading is
      // unrestricted; chmod and chown take a mode or owner first.
      const paths = base === 'chmod' || base === 'chown' ? args.slice(1) : args.slice(-1)
      if (!paths.length || !paths.every((p) => autoMayWrite(p, dir))) {
        return `\`${base}\` is pointed at a protected file or outside your home directory`
      }
    }
  }
  return null
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
