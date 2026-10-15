// A page room's agent: a Hermes profile with only that room's tools (an MCP
// server), started once per typed message and resumed by session name so
// follow-ups work. Shared by the page-room services (scripts/discord-room,
// later scripts/watchlist).
//
// Nothing stays running between messages: one call is ~230 MB for ~20 s on
// the Pi (measured 2026-10-15; ~14 s of it is Hermes starting). Calls from
// every room queue on one lock file, so at most one room agent runs at a time.
import { execFile } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'

const HERMES = process.env.ROOM_AGENT_HERMES ?? path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes')
const LOCK = process.env.ROOM_AGENT_LOCK ?? `/run/user/${process.getuid()}/room-agent.lock`
const TIMEOUT_MS = 4 * 60 * 1000

// Hermes' own status lines around the reply, not part of it.
const NOISE = [/^session_id:/, /^↻ Resumed session/, /^Session \S+ found but has no messages/, /^\s*$/]

/**
 * Ask a room's agent. Resolves with its reply text; rejects with an Error
 * whose message is fit to show in the room.
 * @param {{profile: string, session: string, text: string}} opts
 */
export function askRoomAgent({ profile, session, text }) {
  const args = [LOCK, HERMES, '-p', profile, 'chat', '-Q', '-q', text,
    '--continue', session, '--create-if-missing']
  return new Promise((resolve, reject) => {
    execFile('flock', args, { cwd: os.tmpdir(), timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const reply = String(stdout ?? '').split('\n').filter((l) => !NOISE.some((re) => re.test(l))).join('\n').trim()
      if (err && !reply) {
        const why = err.killed ? 'took too long' : (String(stderr ?? '').trim().split('\n').pop() || err.message)
        return reject(new Error(`The room's agent failed: ${why}`))
      }
      resolve(reply || 'The agent had nothing to say.')
    })
  })
}

/**
 * One queue per room: typed messages answer in order, without holding up the
 * service's sync loop (taps on the page must stay instant).
 */
export function roomAgentQueue() {
  let tail = Promise.resolve()
  return (job) => {
    tail = tail.then(() => job()).catch(() => {})
    return tail
  }
}
