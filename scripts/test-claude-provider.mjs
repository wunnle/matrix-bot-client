import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claude, progressForToolUse, mainAgentBlocks } from './providers/claude.mjs'

// Progress carries the agent's own description and file names, never raw
// commands, patterns, queries or URLs.
const progressCases = [
  [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'TOKEN=secret npm test', description: 'Run tests' } },
    { id: 't1', emoji: '💻', tool: 'terminal', content: 'Run tests' }],
  [{ type: 'tool_use', id: 't1b', name: 'Bash', input: { command: 'TOKEN=secret npm test' } },
    { id: 't1b', emoji: '💻', tool: 'terminal', content: 'Running a command' }],
  [{ type: 'tool_use', id: 't1c', name: 'Bash', input: { command: 'x', description: `  Line one\n  line two ${'y'.repeat(100)}` } },
    { id: 't1c', emoji: '💻', tool: 'terminal', content: `Line one line two ${'y'.repeat(61)}…` }],
  [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/src/app.ts' } },
    { id: 't2', emoji: '📖', tool: 'read', content: 'src/app.ts' }],
  // Outside the checkout: the file name only, not where it lives.
  [{ type: 'tool_use', id: 't2b', name: 'Read', input: { file_path: '/home/me/.secrets/token.json' } },
    { id: 't2b', emoji: '📖', tool: 'read', content: 'token.json' }],
  [{ type: 'tool_use', id: 't2c', name: 'Read', input: { file_path: '/repo-other/a.txt' } },
    { id: 't2c', emoji: '📖', tool: 'read', content: 'a.txt' }],
  [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/repo/.env', old_string: 'SECRET=a', new_string: 'SECRET=b' } },
    { id: 't3', emoji: '✏️', tool: 'edit', content: '.env' }],
  [{ type: 'tool_use', id: 't3b', name: 'Grep', input: { pattern: 'sk-live-secret' } },
    { id: 't3b', emoji: '🔎', tool: 'search', content: 'Searching the code' }],
  [{ type: 'tool_use', id: 't3c', name: 'Agent', input: { description: 'Survey repo layout', prompt: 'secret' } },
    { id: 't3c', emoji: '🤖', tool: 'agent', content: 'Survey repo layout' }],
  [{ type: 'tool_use', id: 't4', name: 'WebSearch', input: { query: 'private acquisition target' } },
    { id: 't4', emoji: '🌐', tool: 'websearch', content: 'Searching the web' }],
  [{ type: 'tool_use', id: 't4b', name: 'WebFetch', input: { url: 'https://x.test/?token=secret' } },
    { id: 't4b', emoji: '🌐', tool: 'fetch', content: 'Fetching a page' }],
  [{ type: 'tool_use', id: 't5', name: 'mcp__private__lookup', input: { token: 'secret' } },
    { id: 't5', emoji: '🔧', tool: 'lookup', content: 'Using private' }],
  [{ type: 'tool_use', id: 't6', name: 'Skill', input: { skill: 'deploy', args: 'secret' } },
    { id: 't6', emoji: '🧩', tool: 'skill', content: 'Using deploy' }],
  [{ type: 'tool_use', id: 't7', name: 'SomethingNew', input: { x: 'secret' } },
    { id: 't7', emoji: '🔧', tool: 'somethingnew', content: 'Using a tool' }],
  [{ type: 'tool_use', id: 't8', name: 'TodoWrite', input: {} }, null],
  [{ type: 'text', text: 'hello' }, null],
]
for (const [block, expected] of progressCases) {
  assert.deepEqual(progressForToolUse(block, '/repo'), expected)
}
// No checkout known: never a full path.
assert.equal(progressForToolUse(progressCases[3][0]).content, 'app.ts')

const assistant = (content, extra = {}) => ({ type: 'assistant', message: { content }, parent_tool_use_id: null, ...extra })
const blocks = [{ type: 'text', text: 'x' }, progressCases[0][0]]
assert.deepEqual(mainAgentBlocks(assistant(blocks)), blocks)
// A subagent's own text and tool calls stay out of the room.
assert.deepEqual(mainAgentBlocks(assistant(blocks, { parent_tool_use_id: 'task1' })), [])
assert.deepEqual(mainAgentBlocks({ type: 'user', message: { content: [] } }), [])

// End to end against a fake `claude` that streams the way the real one does.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
const fake = path.join(dir, 'claude')
fs.writeFileSync(fake, `#!/usr/bin/env node
const mode = process.env.FAKE_CLAUDE_MODE
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (mode === 'hang') { out({ type: 'system', subtype: 'init', session_id: 's-hang' }); setInterval(() => {}, 1000) }
else if (mode === 'crash') { process.stderr.write('boom\\n'); process.exit(3) }
else {
  const say = (text, parent = null) => out({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } })
  out({ type: 'system', subtype: 'init', session_id: 's1' })
  say('  Looking around. ')
  say('subagent chatter', 'task1')
  const bash = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }] } }
  // Split one event across writes to exercise line reassembly.
  const line = JSON.stringify(bash) + '\\n'
  process.stdout.write(line.slice(0, 20))
  setTimeout(() => {
    process.stdout.write(line.slice(20))
    out(bash) // repeated block id: reported once
    say('Found it.')
    say('Checking one more.') // text after text: the first is narration too
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }] } })
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'c', name: 'TodoWrite', input: {} }] } })
    say('Done.') // the reply: the result repeats it, so it is not narration
    // No trailing newline on the last event.
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.', is_error: false, session_id: 's1' }))
  }, 50)
}
`)
fs.chmodSync(fake, 0o755)
process.env.PATH = `${dir}:${process.env.PATH}`

const approval = { url: 'http://127.0.0.1:1/approve', timeoutMs: 1000 }
const base = { prompt: 'hi', cwd: dir, model: 'm', sessionId: null, approval }

{
  // One timeline, so the order the room would see is checked too.
  const seen = []
  let session = null
  const res = await claude.run({
    ...base, roomId: '!ok', timeoutMs: 10000,
    onProgress: (p) => seen.push(`tool:${p.tool}`),
    onText: (t) => seen.push(`text:${t}`),
    onSession: (id) => { session = id },
  })
  assert.deepEqual(res, { text: 'Done.', isError: false })
  assert.equal(session, 's1')
  assert.deepEqual(seen, [
    'text:Looking around.',
    'tool:terminal',
    'text:Found it.',
    'text:Checking one more.',
    'tool:read',
  ])
}

{
  // Throwing callbacks must not sink the turn.
  const fail = () => { throw new Error('x') }
  const res = await claude.run({ ...base, roomId: '!throw', timeoutMs: 10000, onProgress: fail, onText: fail })
  assert.equal(res.text, 'Done.')
}

process.env.FAKE_CLAUDE_MODE = 'crash'
{
  const res = await claude.run({ ...base, roomId: '!crash', timeoutMs: 10000 })
  assert.deepEqual(res, { error: 'boom' })
}

process.env.FAKE_CLAUDE_MODE = 'hang'
{
  const res = await claude.run({ ...base, roomId: '!timeout', timeoutMs: 300 })
  assert.match(res.error, /^Timed out/)
}
{
  const pending = claude.run({ ...base, roomId: '!stop', timeoutMs: 10000 })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(claude.cancel('!stop'), true)
  const res = await pending
  assert.ok(res.error, 'a cancelled turn resolves with an error')
  assert.equal(claude.cancel('!stop'), false)
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('claude provider: ok')
