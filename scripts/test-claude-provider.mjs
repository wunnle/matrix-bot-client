import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claude, progressForToolUse, mainAgentBlocks, createSubagentTracker } from './providers/claude.mjs'

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

// Subagent cards follow the event shapes a real 2.1.306 stream carries.
{
  const snaps = []
  const t = createSubagentTracker({ cwd: '/repo', onChange: (c) => snaps.push(c) })
  const spawnCall = assistant([{ type: 'tool_use', id: 'A', name: 'Agent', input: { description: 'Survey the repo', prompt: 'secret plan', subagent_type: 'Explore', run_in_background: true } }])
  assert.equal(t.handle(spawnCall), false, 'the main agent still sees its own call')
  assert.equal(snaps.at(-1).status, 'running')
  assert.equal(snaps.at(-1).description, 'Survey the repo')
  assert.ok(!JSON.stringify(snaps).includes('secret plan'), 'the prompt never reaches the card')
  assert.equal(t.handle({ type: 'system', subtype: 'task_started', tool_use_id: 'A', subagent_type: 'Explore', is_backgrounded: true }), true)
  // The subagent's own calls are lines, with the same redaction as the main agent's.
  assert.equal(t.handle(assistant([{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'TOKEN=s ls', description: 'List files' } }], { parent_tool_use_id: 'A' })), true)
  assert.deepEqual(snaps.at(-1).lines, [{ emoji: '💻', tool: 'terminal', content: 'List files' }])
  // A nested subagent's events land on the outer card.
  t.handle(assistant([{ type: 'tool_use', id: 'N', name: 'Task', input: { description: 'Dig deeper' } }], { parent_tool_use_id: 'A' }))
  t.handle(assistant([{ type: 'tool_use', id: 'x2', name: 'Read', input: { file_path: '/repo/src/a.ts' } }], { parent_tool_use_id: 'N' }))
  assert.deepEqual(snaps.at(-1).lines.map((l) => l.content), ['List files', 'Dig deeper', 'src/a.ts'])
  t.handle({ type: 'system', subtype: 'task_progress', tool_use_id: 'A', usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 1793.6 } })
  assert.equal(snaps.at(-1).durationMs, 1794, 'integers only: Matrix rejects floats')
  t.handle({ type: 'system', subtype: 'task_notification', tool_use_id: 'A', status: 'completed', summary: ' 64 files ', usage: { total_tokens: 1500, tool_uses: 3, duration_ms: 3538 } })
  assert.deepEqual(
    (({ status, summary, tokens, toolUses, agentType, background }) => ({ status, summary, tokens, toolUses, agentType, background }))(snaps.at(-1)),
    { status: 'completed', summary: '64 files', tokens: 1500, toolUses: 3, agentType: 'Explore', background: true },
  )
  // Events of subagents it never saw start are left alone; a nested task's own
  // system events don't touch the outer card.
  assert.equal(t.handle({ type: 'system', subtype: 'task_notification', tool_use_id: 'zzz', status: 'completed' }), false)
  assert.equal(t.handle({ type: 'system', subtype: 'task_notification', tool_use_id: 'N', status: 'failed' }), false)
  assert.equal(snaps.at(-1).status, 'completed')
  // One still running when the process goes away is marked stopped; finished ones stay.
  t.handle(assistant([{ type: 'tool_use', id: 'B', name: 'Task', input: { description: 'Second' } }]))
  t.handle({ type: 'system', subtype: 'task_notification', tool_use_id: 'B', status: 'killed' })
  assert.equal(snaps.at(-1).status, 'stopped', 'unknown statuses never read as success')
  t.handle(assistant([{ type: 'tool_use', id: 'C', name: 'Task', input: {} }]))
  const before = snaps.length
  t.close()
  assert.equal(snaps.length, before + 1)
  assert.deepEqual([snaps.at(-1).id, snaps.at(-1).status, snaps.at(-1).description], ['C', 'stopped', 'Subagent'])
  assert.ok(!/\.\d/.test(JSON.stringify(snaps)), 'no floats anywhere')
}

// End to end against a fake `claude` that streams the way the real one does.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
const fake = path.join(dir, 'claude')
fs.writeFileSync(fake, `#!/usr/bin/env node
const mode = process.env.FAKE_CLAUDE_MODE
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (mode === 'hang') { out({ type: 'system', subtype: 'init', session_id: 's-hang' }); setInterval(() => {}, 1000) }
else if (mode === 'subagent') {
  // Background subagent: the turn ends first, its report starts a second one.
  const call = { type: 'tool_use', id: 'S', name: 'Agent', input: { description: 'Count files', subagent_type: 'general-purpose' } }
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [call] } })
  out({ type: 'system', subtype: 'task_started', tool_use_id: 'S', subagent_type: 'general-purpose', is_backgrounded: true })
  out({ type: 'assistant', parent_tool_use_id: 'S', message: { content: [{ type: 'tool_use', id: 'k', name: 'Bash', input: { description: 'Count' } }] } })
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Running in the background.' }] } })
  out({ type: 'result', subtype: 'success', result: 'Running in the background.', is_error: false, session_id: 's2' })
  out({ type: 'system', subtype: 'task_notification', tool_use_id: 'S', status: 'completed', summary: '64' })
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '64' }] } })
  out({ type: 'result', subtype: 'success', result: '64', is_error: false, session_id: 's2' })
}
else if (mode === 'crash') { process.stderr.write('boom\\n'); process.exit(3) }
else if (mode === 'chat') {
  // Like the real CLI with stream-json input: a message waiting at a tool
  // boundary joins the turn; one marked "late" stands for a message that lands
  // mid-answer, so it gets a turn and a result of its own after this one.
  const inbox = []
  let turn = null
  const replay = () => out({ type: 'user', isReplay: true })
  const runTurn = async (texts) => {
    texts.forEach(replay)
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't' + Math.random(), name: 'Bash', input: {} }] } })
    await new Promise((r) => setTimeout(r, 150))
    for (let i = inbox.length - 1; i >= 0; i--) {
      if (!inbox[i].includes('late')) { replay(); texts.push(...inbox.splice(i, 1)) }
    }
    const answer = 'answer: ' + texts.join(' | ')
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: answer }] } })
    out({ type: 'result', subtype: 'success', result: answer, is_error: false, session_id: 's-chat' })
  }
  const next = () => {
    if (turn || !inbox.length) return
    turn = runTurn([inbox.shift()]).then(() => { turn = null; next() })
  }
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => {
    const lines = (buf + c).split('\\n'); buf = lines.pop()
    for (const l of lines) if (l.trim()) inbox.push(JSON.parse(l).message.content)
    next()
  })
}
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
  const pending = claude.run({
    ...base, roomId: '!ok', timeoutMs: 10000,
    onProgress: (p) => seen.push(`tool:${p.tool}`),
    onText: (t) => seen.push(`text:${t}`),
    onSession: (id) => { session = id },
  })
  const roots = claude.processRoots()
  assert.equal(roots.length, 1)
  assert.deepEqual(roots[0].roomIds, ['!ok'])
  assert.ok(roots[0].pid > 0)
  const res = await pending
  assert.deepEqual(claude.processRoots(), [], 'completed processes leave no stale room mapping')
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

process.env.FAKE_CLAUDE_MODE = 'subagent'
{
  const seen = []
  const res = await claude.run({
    ...base, roomId: '!sub', timeoutMs: 10000,
    onProgress: (p) => seen.push(`tool:${p.tool}`),
    onText: (t) => seen.push(`text:${t}`),
    onSubagent: (c) => seen.push(`card:${c.status}:${c.lines.length}`),
  })
  assert.deepEqual(res, { text: '64', isError: false })
  assert.deepEqual(seen, [
    'card:running:0', 'card:running:0', 'card:running:1',
    'card:completed:1',
    'text:Running in the background.',
  ], 'the card replaces the agent line, and the subagent\'s Bash is on the card, not in the room')
}

process.env.FAKE_CLAUDE_MODE = 'chat'
{
  // A message sent mid-turn joins the turn rather than waiting for the next.
  assert.equal(claude.steer('!steer', 'nobody home'), false, 'no turn, nothing to steer')
  const seen = []
  const pending = claude.run({ ...base, roomId: '!steer', timeoutMs: 10000, onText: (t) => seen.push(t) })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(claude.steer('!steer', 'actually'), true)
  const res = await pending
  assert.deepEqual(res, { text: 'answer: hi | actually', isError: false })
  assert.deepEqual(seen, [])
  assert.equal(claude.steer('!steer', 'too late'), false, 'a finished turn takes nothing more')
}
{
  // One that lands mid-answer is answered too, before the turn ends; the first
  // answer becomes narration and the last one is the reply.
  const seen = []
  const pending = claude.run({ ...base, roomId: '!late', timeoutMs: 10000, onText: (t) => seen.push(t) })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(claude.steer('!late', 'late one'), true)
  const res = await pending
  assert.deepEqual(res, { text: 'answer: late one', isError: false })
  assert.deepEqual(seen, ['answer: hi'])
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
