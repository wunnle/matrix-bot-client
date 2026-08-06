// Claude Code provider — runs a turn by shelling out to `claude -p`.
//
// One process per turn, so there is no connection to keep alive: the session
// lives on disk under the id the CLI hands back, and `--resume` picks it up.
// Approvals leave this process entirely — the PreToolUse hook posts them to the
// bot's broker over loopback (see claude-approval-hook.mjs), so the adapter's
// only job there is to pass the broker's address down to the hook.
import * as path from 'node:path'
import { execFile } from 'node:child_process'

// Short names accepted in !spawn / !model, mapped to the exact CLI model ids.
const MODELS = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
}

const HOOK_PATH = path.join(import.meta.dirname, '..', 'claude-approval-hook.mjs')
const APPROVAL_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: `node ${HOOK_PATH}` }] },
    ],
  },
})

// Turns in flight, so a turn can be stopped without waiting it out. Keyed by
// room because that is the unit the bot serialises on — a room has at most one.
const running = new Map()

export const claude = {
  name: 'claude',
  models: MODELS,
  defaultModel: MODELS.opus,

  // Accept a bare alias or a full id; anything else is not ours.
  resolveModel(name) {
    const key = String(name).toLowerCase()
    if (MODELS[key]) return MODELS[key]
    if (Object.values(MODELS).includes(key)) return key
    return null
  },

  // Short alias for a resolved model id, for display.
  label(model) {
    return Object.keys(MODELS).find((k) => MODELS[k] === model) ?? model
  },

  // Runs one turn. `sessionId` resumes the room's prior conversation; the new
  // id comes back through `onSession` so the bot can persist it — the CLI only
  // reveals it once the turn ends, which is why it is a callback and not a
  // return value the caller could rely on mid-turn.
  run({ roomId, prompt, cwd, model, sessionId, instructions = [], approval, timeoutMs, onSession }) {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--model', model,
      // The PreToolUse hook is the real gate; see claude-approval-hook.mjs.
      '--settings', APPROVAL_SETTINGS,
    ]
    if (sessionId) args.push('--resume', sessionId)
    // One combined flag: repeating --append-system-prompt only keeps the last.
    if (instructions.length) args.push('--append-system-prompt', instructions.join('\n\n'))

    return new Promise((resolve) => {
      const child = execFile('claude', args, {
        cwd,
        // A turn can block on a human answering an approval, so this must
        // exceed the approval timeout rather than race it.
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        // The hook runs as a grandchild of this process; hand it the broker
        // address so an overridden port stays consistent.
        env: {
          ...process.env,
          AGENT_APPROVAL_URL: approval.url,
          AGENT_APPROVAL_TIMEOUT_MS: String(approval.timeoutMs),
          // Which room to ask. Cannot be derived from the session id during a
          // room's first turn, because that id is only known once it ends.
          AGENT_ROOM_ID: roomId,
        },
      }, (err, stdout, stderr) => {
        running.delete(roomId)
        if (err && !stdout) return resolve({ error: stderr?.trim() || err.message })
        try {
          const out = JSON.parse(stdout)
          if (out.session_id) onSession?.(out.session_id)
          resolve({ text: out.result ?? '(no output)', isError: out.is_error })
        } catch {
          resolve({ error: `Could not parse output:\n${stdout.slice(0, 500)}` })
        }
      })
      running.set(roomId, child)
    })
  },

  // Stops the turn in flight, if any. The kill surfaces through execFile's
  // error path, so the caller still gets a resolved turn rather than a hang.
  cancel(roomId) {
    const child = running.get(roomId)
    if (!child) return false
    child.kill('SIGTERM')
    return true
  },
}
