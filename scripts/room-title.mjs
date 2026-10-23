// A name for a room spawned with a prompt (!spawn … -- <prompt>, or the app's
// "What do you want to do?"), so it is named for its work from the start
// instead of BenderDev-N until the agent renames it. Same rules as the
// room-rename skill: about two words, at most 24 characters, the task not the
// tooling. The room is created under the prompt's first words and renamed when
// Haiku answers (~6 s); a slow or failed call just leaves the first words.
import { spawn } from 'node:child_process'

const MAX = 24

export function titlePrompt(request) {
  return 'Name this chat room in 2 words (max 24 characters, Title Case, no quotes or ' +
    'punctuation), saying what the work is, not the tooling. Use the language of the ' +
    `request. Reply with the name only.\n\nRequest: ${JSON.stringify(String(request).slice(0, 2000))}`
}

// One line, no quotes or trailing punctuation, cut at a word under the limit.
export function cleanTitle(raw) {
  const line = String(raw ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const bare = line.replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.!?:;,\s]+$/g, '').replace(/\s+/g, ' ')
  // The CLI prints this on stdout, exit 0 or not; it is not a name.
  if (!bare || /^not logged in/i.test(bare)) return null
  return fitWords(bare)
}

function fitWords(text) {
  if (text.length <= MAX) return text
  let out = ''
  for (const word of text.split(' ')) {
    const next = out ? `${out} ${word}` : word
    if (next.length > MAX) break
    out = next
  }
  return out || text.slice(0, MAX)
}

// The prompt's first few words, for when no model answers in time.
export function fallbackTitle(request) {
  const words = String(request).replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 3)
  if (!words.length) return null
  const text = words.map((w) => w[0].toLocaleUpperCase('tr') + w.slice(1)).join(' ')
  return fitWords(text)
}

// Never throws and never takes longer than `timeoutMs`.
export function roomTitle(request, { timeoutMs = 15000, log = () => {} } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (title, why) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!title && why) log(`Room title fell back to the prompt: ${why}`)
      resolve(title ?? fallbackTitle(request))
    }
    // No user settings (their hooks would run), no tools, no MCP: a one-shot
    // question on the account's own login, which --bare would not use.
    const child = spawn('claude', [
      '-p', '--model', 'claude-haiku-4-5', '--output-format', 'text',
      '--setting-sources', 'local', '--strict-mcp-config', '--disable-slash-commands', '--tools', '',
    ], { cwd: '/tmp', env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(null, 'timed out') }, timeoutMs)
    child.on('error', (e) => finish(null, e.message))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => { out += c })
    child.on('close', (code) => finish(code === 0 ? cleanTitle(out) : null, `claude exited ${code}`))
    child.stdin.on('error', () => {})
    child.stdin.end(titlePrompt(request))
  })
}
