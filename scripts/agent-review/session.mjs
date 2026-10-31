// Prints one Hermes conversation, read-only, so the agent reviewer can open a
// session the collector flagged without writing (and being asked to run) a
// script of its own. Pre-approved in approval-rules.mjs by its path.
//
//   node ~/matrix-pwa/scripts/agent-review/session.mjs <profile|default> <session_id> [--from N] [--max CHARS]
//   node ~/matrix-pwa/scripts/agent-review/session.mjs <profile|default> --list [days]
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [profile, sessionId, ...rest] = process.argv.slice(2)
if (!profile || !sessionId || !/^[\w-]+$/.test(profile)) {
  console.error('usage: session.mjs <profile|default> <session_id> [--from N] [--max CHARS] | --list [days]')
  process.exit(2)
}
const opt = (name, fallback) => Number(rest[rest.indexOf(name) + 1]) || fallback
const home = path.join(os.homedir(), '.hermes')
const db = new DatabaseSync(path.join(profile === 'default' ? home : path.join(home, 'profiles', profile), 'state.db'), { readOnly: true })
const when = (ts) => new Date(ts * 1000).toISOString().slice(0, 16)

if (sessionId === '--list') {
  const since = Date.now() / 1000 - (Number(rest[0]) || 7) * 86400
  for (const s of db.prepare(`select id, source, title, message_count, tool_call_count, coalesce(last_activity_at, started_at) at
      from sessions where coalesce(last_activity_at, started_at) >= ? order by at desc`).all(since)) {
    console.log(`${when(s.at)} ${s.id} [${s.source}] ${s.message_count} msgs, ${s.tool_call_count} tools — ${s.title ?? ''}`)
  }
  process.exit(0)
}

const max = opt('--max', 600)
const rows = db.prepare('select role, content, tool_name, tool_calls, timestamp from messages where session_id = ? order by timestamp, id').all(sessionId)
if (!rows.length) {
  console.error(`no messages for ${sessionId} in ${profile}`)
  process.exit(1)
}
rows.slice(opt('--from', 0)).forEach((r, i) => {
  const text = String(r.content ?? '').slice(0, max).replace(/\n/g, ' ⏎ ')
  const calls = r.tool_calls ? ` → calls ${String(r.tool_calls).slice(0, 300)}` : ''
  console.log(`#${i + opt('--from', 0)} ${when(r.timestamp)} [${r.role}${r.tool_name ? ` ${r.tool_name}` : ''}] ${text}${calls}`)
})
