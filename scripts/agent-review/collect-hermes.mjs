// Hermes side of the agent review: a week of Bender and the other profiles,
// read straight from their state.db files and logs. Read-only throughout.
//
//   node scripts/agent-review/collect-hermes.mjs [days]   → findings markdown on stdout
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DAY_MS, clip, createReport, gaveUp, isCorrection, run } from './lib.mjs'

const HERMES = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes')
// Scripted prompts (room agents, digests, cards) and cron jobs have no human
// typing, so a "no" in them is part of the prompt, not a correction.
const MACHINE_SOURCES = new Set(['cron', 'oneshot', 'webhook'])
// The gateway prefixes routed messages with this JSON block; the user's words follow it.
const ORIGIN_PREFIX = /^Gateway message origin[^\n]*\n\{[^\n]*\}\n(Do not guess[^\n]*\n)?\s*/
// Harness notices in the user role ("[ASYNC DELEGATION BATCH COMPLETE …]").
const HARNESS_NOTICE = /^\[[A-Z][A-Z ]+[\]—-]/

function profiles() {
  const list = [{ name: 'default', dir: HERMES }]
  const dir = path.join(HERMES, 'profiles')
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (fs.existsSync(path.join(dir, name, 'state.db'))) list.push({ name, dir: path.join(dir, name) })
  }
  return list
}

function toolFailed(content) {
  let o
  try { o = JSON.parse(content) } catch { return null }
  if (!o || typeof o !== 'object') return null
  if (o.error) return typeof o.error === 'string' ? o.error : JSON.stringify(o.error)
  if (o.success === false) return o.message ?? o.reason ?? 'success: false'
  if (typeof o.exit_code === 'number' && o.exit_code !== 0) return `exit ${o.exit_code}: ${o.output ?? o.stderr ?? ''}`
  return null
}

function readDb(profile, since) {
  const db = new DatabaseSync(path.join(profile.dir, 'state.db'), { readOnly: true })
  try {
    const rows = db.prepare(`
      select m.session_id, m.role, m.content, m.tool_name, m.timestamp, s.source, s.title
      from messages m join sessions s on s.id = m.session_id
      where m.timestamp >= ? order by m.session_id, m.timestamp, m.id`).all(since / 1000)
    const heavy = db.prepare(`
      select id, source, title, tool_call_count, message_count from sessions
      where coalesce(last_activity_at, started_at) >= ? and source not in ('cron', 'oneshot', 'webhook')
        and tool_call_count >= 25 order by tool_call_count desc limit 5`).all(since / 1000)
    return { rows, heavy }
  } finally { db.close() }
}

function scanProfile(profile, since, found) {
  const { rows, heavy } = readDb(profile, since)
  let lastAssistant = null
  let lastSession = null
  for (const r of rows) {
    if (r.session_id !== lastSession) { lastSession = r.session_id; lastAssistant = null }
    const text = String(r.content ?? '')
    const when = new Date(r.timestamp * 1000).toISOString().slice(0, 16)
    const where = `${profile.name} · ${r.session_id}${r.title ? ` (${clip(r.title, 50)})` : ''}`
    if (r.role === 'user' && !MACHINE_SOURCES.has(r.source)) {
      const said = text.replace(ORIGIN_PREFIX, '')
      if (lastAssistant && !HARNESS_NOTICE.test(said) && isCorrection(said)) {
        found.corrections.push(`${when} ${where}\n  - agent: "${clip(lastAssistant, 240)}"\n  - Sinan: "${clip(said, 240)}"`)
      }
    } else if (r.role === 'assistant' && text.trim()) {
      lastAssistant = text
      if (!MACHINE_SOURCES.has(r.source) && gaveUp(text)) found.gaveUp.push(`${when} ${where}: "${clip(text, 240)}"`)
    } else if (r.role === 'tool') {
      const err = toolFailed(text)
      if (err) {
        const key = `${profile.name} · ${r.tool_name ?? 'tool'}`
        const g = found.toolErrors.get(key) ?? { n: 0, samples: [] }
        g.n++
        if (g.samples.length < 2) g.samples.push(`${when} ${clip(err, 160)}`)
        found.toolErrors.set(key, g)
      }
    }
  }
  for (const s of heavy) {
    found.heavy.push(`${profile.name} · ${s.id} (${s.source}${s.title ? `, ${clip(s.title, 50)}` : ''}): ${s.tool_call_count} tool calls, ${s.message_count} messages`)
  }
}

function memoryFill(profile, found) {
  const config = (() => { try { return fs.readFileSync(path.join(profile.dir, 'config.yaml'), 'utf8') } catch { return '' } })()
  const limit = (key, fallback) => Number(new RegExp(`^\\s*${key}:\\s*(\\d+)`, 'm').exec(config)?.[1] ?? fallback)
  for (const [file, key, fallback] of [['MEMORY.md', 'memory_char_limit', 4000], ['USER.md', 'user_char_limit', 2000]]) {
    const p = path.join(profile.dir, 'memories', file)
    if (!fs.existsSync(p)) continue
    const used = fs.readFileSync(p, 'utf8').length
    const max = limit(key, fallback)
    if (used / max >= 0.85) found.memory.push(`${profile.name} ${file}: ${used}/${max} chars (${Math.round(100 * used / max)}%)`)
  }
}

// errors.log is the gateway's own failures (crashes, adapter errors), grouped
// by module and message shape so one recurring error is one line.
function logErrors(profile, since, found) {
  const p = path.join(profile.dir, 'logs', 'errors.log')
  if (!fs.existsSync(p)) return
  const size = fs.statSync(p).size
  const fd = fs.openSync(p, 'r')
  const buf = Buffer.alloc(Math.min(size, 4 * 1024 * 1024))
  fs.readSync(fd, buf, 0, buf.length, size - buf.length)
  fs.closeSync(fd)
  const groups = new Map()
  for (const line of buf.toString('utf8').split('\n')) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ ERROR (?:\[[^\]]*\] )?(\S+): (.*)$/.exec(line)
    if (!m || new Date(m[1].replace(' ', 'T')).getTime() < since) continue
    const shape = `${m[2]}: ${m[3].replace(/\d+/g, '#').slice(0, 140)}`
    const g = groups.get(shape) ?? { n: 0, last: m[1] }
    g.n++; g.last = m[1]
    groups.set(shape, g)
  }
  for (const [shape, g] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, 6)) {
    found.logErrors.push(`${profile.name} ×${g.n} (last ${g.last}) ${shape}`)
  }
}

async function health(found) {
  const failed = await run('systemctl', ['--user', '--failed', '--no-legend', '--plain'])
  for (const line of failed.out.split('\n').filter(Boolean)) found.health.push(`failed unit: ${line.split(/\s+/)[0]}`)
  // Bender's browser tools drive this Chromium; when it is down they fail on
  // every call and the agent falls back to web search (2026-10-31).
  const browser = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(3000) }).catch(() => null)
  if (!browser?.ok) found.health.push('browser on 127.0.0.1:9222 (hermes-browser.service) is not answering')
  const cron = await run(path.join(os.homedir(), '.local', 'bin', 'hermes'), ['cron', 'list'], { timeout: 60_000 })
  let name = null
  for (const line of cron.out.split('\n')) {
    const n = /^\s*Name:\s*(.*)$/.exec(line)
    if (n) name = n[1]
    const last = /^\s*Last run:\s*(\S+)\s+(\S+)/.exec(line)
    if (last && last[2] !== 'ok') found.health.push(`cron "${name}" last run ${last[1]}: ${last[2]}`)
  }
}

export async function collectHermes(days = 7) {
  const since = Date.now() - days * DAY_MS
  const found = { corrections: [], gaveUp: [], toolErrors: new Map(), heavy: [], memory: [], logErrors: [], health: [] }
  for (const profile of profiles()) {
    try { scanProfile(profile, since, found) } catch (e) { found.health.push(`${profile.name} state.db unreadable: ${e.message}`) }
    memoryFill(profile, found)
    logErrors(profile, since, found)
  }
  await health(found)

  const report = createReport('Hermes agent review: findings', days)
  report.section('Sinan pushed back', found.corrections.slice(-25),
    'Replies to an agent answer that look like a correction or a repeated ask. Read the session around each to see what the agent got wrong.')
  report.section('Agent gave up', found.gaveUp.slice(-15), 'Answers that stopped at "couldn\'t". Was there another way it should have tried?')
  report.section('Failing tools', [...found.toolErrors].sort((a, b) => b[1].n - a[1].n).slice(0, 12)
    .map(([key, g]) => `${key} ×${g.n}\n  - ${g.samples.join('\n  - ')}`))
  report.section('Long sessions', found.heavy, 'Many tool calls in one conversation can mean the agent was flailing.')
  report.section('Memory nearly full', found.memory)
  report.section('Gateway errors', found.logErrors)
  report.section('Health', found.health)
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await collectHermes(Number(process.argv[2] ?? 7))
  process.stdout.write(report.markdown())
}
