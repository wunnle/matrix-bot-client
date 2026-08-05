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
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead', 'WebSearch', 'WebFetch'])
// Writes are fine inside the room's own directory; outside it they need a human.
const PATH_SCOPED = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

// Bash commands that only read state run without a prompt. Anything unrecognised
// — or any sign of mutation (write redirects, sudo, command substitution, find
// -delete/-exec) — falls through to the human approval broker.
const SAFE_BASH_BINS = new Set([
  'ls', 'cat', 'head', 'tail', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep',
  'rg', 'find', 'wc', 'which', 'type', 'whoami', 'id', 'date', 'env', 'sort',
  'uniq', 'cut', 'tr', 'diff', 'stat', 'file', 'du', 'df', 'tree', 'basename',
  'dirname', 'realpath', 'readlink', 'uname', 'hostname', 'sleep', 'true',
  'false', 'test', 'jq', 'shasum', 'md5sum', 'cksum', 'column', 'xxd', 'strings',
  'nl', 'tac', 'comm',
  // Read-only inspection of the machine itself: processes, resources, network,
  // hardware, clock. None of these change state without a flag we reject below.
  'ps', 'pgrep', 'top', 'htop', 'free', 'uptime', 'w', 'last', 'lsof', 'ss',
  'netstat', 'ip', 'ifconfig', 'route', 'arp', 'lsblk', 'lscpu', 'lsusb',
  'lspci', 'mount', 'vmstat', 'iostat', 'nproc', 'groups', 'users',
  'getent', 'locale', 'dig', 'host', 'nslookup', 'ping', 'traceroute',
  'timedatectl', 'hostnamectl', 'localectl', 'vcgencmd',
])
// Read-only by default, but each has flags/subcommands that mutate; the guards
// below reject those before the binary is accepted.
const GUARDED_BINS = {
  // journalctl reads logs; these flags delete, rotate or re-key them.
  journalctl: /--(vacuum-\w+|rotate|flush|sync|relinquish-var|setup-keys|update-catalog|header)\b/,
  // systemctl's read-only verbs are handled via SAFE_SUBCOMMANDS.
}
// Run another program rather than doing anything themselves, so the wrapper's
// own name says nothing about what actually executes: `env rm -rf …` must be
// judged on `rm`, not on `env`.
const WRAPPERS = new Set(['env', 'command', 'nohup', 'stdbuf'])
// Not read-only, but pre-authorised: the Linear CLI only ever touches Sinan's
// own issue tracker, and prompting for every search made the bots unusable.
const PREAPPROVED_BINS = new Set(['linear'])
// The same CLIs reached the long way round, as `node /path/to/thing.js …`.
// Matched on basename so the wrapper and the raw script are judged alike —
// otherwise the call is judged on `node`, which is only safe for --version.
const PREAPPROVED_SCRIPTS = new Set(['linear.js'])
// Programs safe only for specific read-only subcommands.
const SAFE_SUBCOMMANDS = {
  git: new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'describe',
    'blame', 'cat-file', 'shortlog', 'symbolic-ref', 'for-each-ref', 'branch', 'remote']),
  npm: new Set(['test', 'ls', 'list', 'outdated', 'view', 'why', 'run']),
  node: new Set(['--version', '-v']),
  systemctl: new Set(['status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed',
    'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-jobs',
    'show-environment', 'get-default']),
  hermes: new Set(['status']),
}
const SAFE_NPM_SCRIPTS = new Set(['build', 'test', 'lint', 'typecheck'])

function bashIsSafe(command) {
  const cmd = (command ?? '').trim()
  if (!cmd) return false
  if (/\$\(|`|<\(|>\(/.test(cmd)) return false                 // command/process substitution
  if (/(^|\s)sudo(\s|$)/.test(cmd)) return false               // privilege escalation
  if (/-delete\b|-exec(dir)?\b|-ok\b|-fprint\b/.test(cmd)) return false // find mutations
  // Write redirects, allowing only >/dev/null and fd merges (2>&1).
  const noHarmless = cmd.replace(/\d*>&\d+/g, '').replace(/[&\d]*>\s*\/dev\/null/g, '')
  if (noHarmless.includes('>')) return false
  // Every pipeline/sequence segment must be a recognised read-only program.
  return cmd.split(/&&|\|\||\||;|\n/).map((s) => s.trim()).filter(Boolean).every((seg) => {
    let tokens = seg.split(/\s+/)
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1) // strip VAR=val
    let base = (tokens[0] ?? '').split('/').pop()
    // Unwrap to the program that really runs. Bail on flags (env -i, -S …)
    // rather than trying to model each wrapper's option grammar.
    while (WRAPPERS.has(base)) {
      tokens = tokens.slice(1)
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
      if (!tokens.length || tokens[0].startsWith('-')) return false
      base = tokens[0].split('/').pop()
    }
    if (SAFE_BASH_BINS.has(base) || PREAPPROVED_BINS.has(base)) return true
    if (base === 'node' && PREAPPROVED_SCRIPTS.has((tokens[1] ?? '').split('/').pop())) return true
    const guard = GUARDED_BINS[base]
    if (guard) return !guard.test(tokens.slice(1).join(' '))
    const subs = SAFE_SUBCOMMANDS[base]
    if (!subs || !subs.has(tokens[1])) return false
    if (base === 'npm' && tokens[1] === 'run') return SAFE_NPM_SCRIPTS.has(tokens[2])
    // `git branch`/`git remote` list only with no extra args (branch -d, remote add mutate).
    if (base === 'git' && (tokens[1] === 'branch' || tokens[1] === 'remote')) return tokens.length === 2
    return true
  })
}

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

if (toolName === 'Bash' && bashIsSafe(toolInput.command)) {
  decide('allow', 'Bash command on the allowlist.')
}

// Everything else — mutating Bash, writes outside the directory, unknown tools — asks.
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
