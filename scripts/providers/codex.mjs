// Codex provider — runs a turn against `codex app-server` over JSON-RPC.
//
// Unlike the Claude adapter, which shells out per turn, this speaks to one
// long-lived process shared by every room: a room is a *thread* inside it, and
// the resumable id in sessions.json is a threadId. See CLA-119 for the wire
// shapes this was built against (codex-cli 0.130.0) and scripts/
// codex-app-server-spike.mjs for a standalone reference client.
//
// Supervision and reconnection are deliberately minimal here — CLA-123 owns
// that. What this file does guarantee is that a dead connection fails the turn
// loudly rather than hanging it.
import { spawn } from 'node:child_process'
import { bashIsSafe } from '../approval-rules.mjs'

// Seeded from `model/list` on this build; refreshed from the server once
// connected, so a new model appears without a code change. Static seed because
// the registry has to answer resolveModel() synchronously at startup, before
// any app-server exists.
// This is only a seed: it answers `!spawn <path> <model>` before any
// app-server exists, and is replaced by `model/list` on the first connection.
// Expect it to go stale — the list changed under us mid-session once already.
const MODELS = {
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': 'gpt-5.4-mini',
}

// Approvals we can put to the room as a yes/no. Both answer with the same
// decision enum: accept | acceptForSession | decline | cancel.
const ASKABLE = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
])

// Approval-shaped requests we cannot honestly turn into a chat button, but
// which still must be answered or the turn hangs forever:
//   item/permissions/requestApproval  wants a GrantedPermissionProfile, not a
//                                     yes/no — granting it means constructing a
//                                     filesystem permission set.
//   item/tool/requestUserInput        a question for the user, not a decision.
//   mcpServer/elicitation/request     same, from an MCP server.
// Declining these is the safe answer until each gets its own treatment.
const UNSUPPORTED = new Set([
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
])

// Chat answer -> the decision this build actually accepts. Note these are not
// `approved`/`denied`: see CLA-119.
const DECISIONS = {
  allow: 'accept',
  allow_session: 'acceptForSession',
  deny: 'decline',
}

// What the room calls each kind of approval, in "Approve `…`?".
const APPROVAL_LABELS = {
  'item/commandExecution/requestApproval': 'shell command',
  'execCommandApproval': 'shell command',
  'item/fileChange/requestApproval': 'file changes',
  'applyPatchApproval': 'file changes',
}

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}][codex]`, ...args)
}

// Codex runs everything through a login shell, so the command arrives as
// `/bin/bash -lc "the real thing"`. Judging that string as-is asks about
// /bin/bash, which no rule allows — so every command would prompt. Recover the
// script it actually runs.
export function unwrapShell(command) {
  const m = /^\S*\b(?:bash|sh|zsh)\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+([\s\S]+)$/.exec(String(command).trim())
  if (!m) return command
  const rest = m[1].trim()
  const quote = rest[0]
  if (quote !== '"' && quote !== "'") return rest
  // Find the closing quote, honouring backslash escapes inside "".
  let out = ''
  for (let i = 1; i < rest.length; i++) {
    const c = rest[i]
    if (c === '\\' && quote === '"' && i + 1 < rest.length) { out += rest[++i]; continue }
    if (c === quote) return out
    out += c
  }
  // Unbalanced quoting: hand back the original so the rules judge it, and a
  // string we could not parse is one no rule will recognise — it gets asked.
  return command
}

// Approvals the room should never see, because the same rules already let the
// Claude side run them unattended. Codex asks about far less (its sandbox only
// stops what it cannot do), so this fires mainly for reads that reach outside
// the workspace, network reads, and the pre-approved CLIs.
export function autoAllowed(method, params) {
  if (method !== 'item/commandExecution/requestApproval' && method !== 'execCommandApproval') return false
  if (!params?.command) return false
  return bashIsSafe(unwrapShell(params.command), params.cwd ?? process.cwd())
}

// The body of the approval message. A command speaks for itself; a file change
// does not, so its diff is looked up from the item the request points at —
// the approval params carry only an itemId, never the patch.
function describeApproval(method, params = {}, turn) {
  if (params.command) {
    const where = params.cwd ? `\n# in ${params.cwd}` : ''
    return `${params.command}${where}`
  }
  const changes = turn?.fileChanges.get(params.itemId)
  if (changes?.length) {
    const body = changes
      // `kind` is a tagged object ({type: "add"|"delete"|"update"}), so it has
      // to be unwrapped — interpolating it directly prints [object Object].
      .map((c) => `# ${c.kind?.type ?? 'update'} ${c.path}\n${c.diff ?? ''}`.trim())
      .join('\n\n')
    return params.reason ? `# ${params.reason}\n\n${body}` : body
  }
  return params.reason ?? method
}

// One app-server for every room. Connection is lazy: nothing starts until a
// Codex room actually takes a turn.
class AppServer {
  constructor() {
    this.child = null
    this.nextId = 1
    this.pending = new Map()      // request id -> {resolve, reject}
    // Two views of the same live turns: notifications arrive keyed by thread,
    // but callers cancel by room.
    this.turns = new Map()        // threadId -> live turn collector
    this.turnsByRoom = new Map()  // roomId   -> the same collector
    this.buf = ''
    this.ready = null
  }

  // Resolves once the handshake is done. Concurrent callers share one attempt.
  connect() {
    if (this.ready) return this.ready
    this.ready = this.#start().catch((e) => {
      // A failed handshake must not be cached as "connected", or every later
      // turn inherits the failure.
      this.ready = null
      throw e
    })
    return this.ready
  }

  async #start() {
    // `--disable apps` drops the `codex_apps` MCP server, which otherwise
    // exposes ~130 tools from the ChatGPT account's connectors — including
    // github_create_commit, github_merge_pull_request, github_delete_file and
    // the sites_* deploy tools.
    //
    // Two gates miss all of it. The gh wrapper never sees these because they
    // never invoke `gh`, and it hard-denies `gh api` precisely because API
    // access cannot be scoped to a repo. The approval broker never sees them
    // because an MCP tool call is neither a command nor a file change, so it
    // reaches no prompt at all.
    //
    // Per-invocation, so the interactive `codex` TUI keeps its connectors.
    // Anything reachable over MCP is outside the allowlist by construction; if
    // a server is ever wanted here, gate it at mcpServer/tool/call first.
    const child = spawn('codex', ['app-server', '--disable', 'apps'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    // app-server dumps whole system prompts into stderr when its model refresh
    // fails, so this is truncated rather than relayed verbatim.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) log('stderr:', line.slice(0, 200))
      }
    })
    child.on('exit', (code, signal) => this.#onExit(code, signal))
    child.on('error', (e) => this.#onExit(null, e.message))

    await this.request('initialize', {
      clientInfo: { name: 'construct-agent-bot', title: 'Construct agent rooms', version: '1.0.0' },
    })
    // Fire-and-forget; the server expects it before doing real work.
    this.notify('initialized', {})
    log('app-server ready')
    this.#refreshModels()
    // Say what tools exist outside the approval gate. An MCP server reaches no
    // prompt — not a command, not a file change — so anything listed here is
    // capability the broker cannot see. Silence is how ~130 connector tools sat
    // in agent rooms unnoticed; this line is the check that it stays empty.
    this.#reportMcp()
    return child
  }

  // Fails everything in flight. Silence here would look like a hung turn.
  #onExit(code, signal) {
    const reason = `codex app-server exited (${signal ?? `code ${code}`})`
    log(reason)
    this.child = null
    this.ready = null
    for (const [, waiter] of this.pending) waiter.reject(new Error(reason))
    this.pending.clear()
    for (const [, turn] of this.turns) turn.fail(reason)
    this.turns.clear()
    this.turnsByRoom.clear()
  }

  // Newline-delimited JSON, one JSON-RPC message per line. No Content-Length
  // headers — this is not LSP/MCP framing.
  #onData(chunk) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        log('unparseable line:', line.slice(0, 200))
        continue
      }
      this.#handle(msg)
    }
  }

  #handle(msg) {
    // Response to one of ours.
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (!waiter) return
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
      return
    }
    // Server -> client request: has both id and method, and must be answered.
    if (msg.id !== undefined && msg.method !== undefined) {
      this.#onServerRequest(msg)
      return
    }
    // Notification.
    const threadId = msg.params?.threadId
    const turn = threadId ? this.turns.get(threadId) : null
    turn?.onNotification(msg)
  }

  #onServerRequest(msg) {
    const turn = this.turns.get(msg.params?.threadId)

    if (ASKABLE.has(msg.method)) {
      if (autoAllowed(msg.method, msg.params)) {
        log(`auto-allowed: ${String(msg.params.command).slice(0, 120)}`)
        this.respond(msg.id, { decision: 'accept' })
        return
      }
      // Fire and forget: the turn is blocked on this request, so awaiting it
      // here would stall the read loop that has to keep draining the socket.
      this.#askRoom(msg, turn)
      return
    }

    // Codex hit a 401 and is asking the client for fresh ChatGPT tokens. Only
    // a client that owns the login can answer — the response requires an
    // accessToken, and ours lives in ~/.codex/auth.json, which codex refreshes
    // itself. So there is no honest success here; what matters is that the
    // room is told, because the fix is a human running `codex login`.
    if (msg.method === 'account/chatgptAuthTokens/refresh') {
      const note = 'Codex could not authenticate (401) and asked me to refresh its ChatGPT login. ' +
        'I cannot — run `codex login` on the Pi.'
      log(`auth refresh requested (reason: ${msg.params?.reason ?? 'unknown'}) — ${note}`)
      // The request carries no threadId, so it cannot be routed to one room.
      // Every turn in flight is about to fail for this reason; tell them all.
      for (const [, turn] of this.turns) turn.onDeclined('ChatGPT auth refresh', note)
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'this client does not manage ChatGPT auth; codex owns ~/.codex/auth.json' },
      })
      return
    }

    if (UNSUPPORTED.has(msg.method)) {
      turn?.onDeclined(msg.method, msg.params?.command ?? msg.params?.reason)
      log(`declined ${msg.method} (not answerable from chat)`)
      this.respond(msg.id, { decision: 'decline' })
      return
    }
    // Unknown request: still answer, or the turn blocks on it forever.
    log(`unhandled server request ${msg.method}; returning an error`)
    this.send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `${msg.method} is not handled by this client` },
    })
  }

  // Puts one approval to the room and answers the server with the result.
  async #askRoom(msg, turn) {
    let decision = 'decline'
    try {
      if (!turn?.ask) throw new Error('no room is listening for this thread')
      const answer = await turn.ask({
        toolName: APPROVAL_LABELS[msg.method] ?? msg.method,
        summary: describeApproval(msg.method, msg.params, turn),
        lang: turn?.fileChanges.get(msg.params?.itemId)?.length ? 'diff' : undefined,
        // Only worth offering where the backend can remember it.
        allowSession: true,
      })
      decision = DECISIONS[answer?.decision] ?? 'decline'
    } catch (e) {
      // Never fall through to "allow" — an approval we could not ask about is
      // an approval nobody granted.
      log(`approval for ${msg.method} failed (${e.message}); declining`)
      turn?.onDeclined(msg.method, msg.params?.command ?? msg.params?.reason)
    }
    try {
      this.respond(msg.id, { decision })
    } catch (e) {
      log(`could not answer ${msg.method}: ${e.message}`)
    }
  }

  send(msg) {
    if (!this.child) throw new Error('codex app-server is not running')
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  respond(id, result) {
    this.send({ jsonrpc: '2.0', id, result })
  }

  // Best-effort, and loud only when there is something to be loud about.
  async #reportMcp() {
    try {
      const list = await this.request('mcpServerStatus/list', {})
      const servers = (list?.data ?? [])
        .map((s) => `${s.name} (${Object.keys(s.tools ?? {}).length} tools)`)
      if (servers.length) log(`⚠️ MCP servers reachable without approval: ${servers.join(', ')}`)
      else log('no MCP servers — every tool call goes through the approval rules')
    } catch (e) {
      log(`could not list MCP servers (${e.message})`)
    }
  }

  // Best-effort: the alias table works without it, and the model refresh is
  // known to fail on some builds.
  async #refreshModels() {
    try {
      const list = await this.request('model/list', {})
      const ids = (list?.data ?? []).map((m) => m.id).filter(Boolean)
      if (!ids.length) return
      for (const key of Object.keys(MODELS)) if (!ids.includes(key)) delete MODELS[key]
      for (const id of ids) MODELS[id] = id
      log(`models: ${ids.join(', ')}`)
    } catch (e) {
      log(`model/list failed (${e.message}); using the built-in list`)
    }
  }
}

const server = new AppServer()

// Collects one turn's notifications into a final answer.
class Turn {
  constructor(threadId, roomId) {
    this.threadId = threadId
    this.roomId = roomId
    this.turnId = null
    this.text = null
    this.declined = []
    this.interrupted = false
    // itemId -> [{path, kind, diff}]. Kept so a file-change approval can show
    // what it would actually do; the request itself carries only the itemId.
    this.fileChanges = new Map()
    // Set by run(): how to put a question to the room this turn belongs to.
    this.ask = null
    this.done = new Promise((resolve) => { this.finish = resolve })
  }

  onNotification(msg) {
    const p = msg.params ?? {}
    switch (msg.method) {
      case 'turn/started':
        // Needed for turn/interrupt, which takes threadId *and* turnId.
        this.turnId = p.turn?.id ?? this.turnId
        break
      case 'item/started':
      case 'item/completed':
        // The reply is the final_answer agent message; other items are tool
        // calls and reasoning, which belong to CLA-103's streaming, not here.
        if (p.item?.type === 'agentMessage' && p.item?.phase === 'final_answer') {
          this.text = p.item.text ?? this.text
        }
        // A pending patch arrives as an item before its approval is requested.
        if (p.item?.type === 'fileChange' && p.item?.changes) {
          this.fileChanges.set(p.item.id, p.item.changes)
        }
        break
      case 'item/fileChange/patchUpdated':
        if (p.changes) this.fileChanges.set(p.itemId, p.changes)
        break
      case 'turn/completed': {
        const turn = p.turn ?? {}
        // `turn/completed` fires even when work was refused, so status and
        // error have to be read rather than assumed.
        if (turn.error) this.finish({ error: String(turn.error.message ?? turn.error) })
        // An interrupted turn usually has no final answer, and reporting that
        // as "(no output)" reads like the agent had nothing to say.
        else if (this.interrupted) this.finish({ text: '⏹ Stopped.', interrupted: true })
        else this.finish({ text: this.#withNotes(), isError: turn.status === 'failed' })
        break
      }
      case 'error':
        this.finish({ error: String(p.message ?? 'app-server reported an error') })
        break
    }
  }

  onDeclined(method, params) {
    this.declined.push(params?.command ?? method)
  }

  // Only covers requests that were refused without anyone being asked. A plain
  // "no" from the room needs no footnote — the human already knows.
  #withNotes() {
    const body = this.text ?? '(no output)'
    if (!this.declined.length) return body
    const list = this.declined.map((d) => `- \`${String(d).slice(0, 200)}\``).join('\n')
    return `${body}\n\n---\n⚠️ Declined ${this.declined.length} request(s) that could not be put to you:\n${list}`
  }

  fail(reason) {
    this.finish({ error: reason })
  }
}

export const codex = {
  name: 'codex',
  models: MODELS,
  defaultModel: 'gpt-5.5',

  resolveModel(name) {
    const key = String(name).toLowerCase()
    return MODELS[key] ?? null
  },

  // The ids are already short enough to type and to show in a room header.
  label(model) {
    return model
  },

  async run({ roomId, prompt, cwd, model, sessionId, instructions = [], approval, timeoutMs, onSession }) {
    let turn
    let timer = null
    try {
      await server.connect()

      const developerInstructions = instructions.join('\n\n') || undefined
      let threadId = sessionId
      if (threadId) {
        // Resume re-applies the thread-scoped settings, so a room picks up an
        // instruction change on its next turn after a restart.
        await server.request('thread/resume', {
          threadId, cwd, model, developerInstructions,
          sandbox: 'workspace-write',
          approvalPolicy: 'on-request',
        })
      } else {
        const started = await server.request('thread/start', {
          cwd, model, developerInstructions,
          // Closest match to the Claude posture: edits inside the room's own
          // directory go through, anything wider has to be approved.
          sandbox: 'workspace-write',
          approvalPolicy: 'on-request',
          // Persistent, so thread/resume has something to resume.
          ephemeral: false,
        })
        threadId = started?.threadId ?? started?.thread?.id
        if (!threadId) return { error: 'codex did not return a threadId' }
        // Known before the turn runs, unlike the Claude session id, so the room
        // is bound to its thread even if this turn dies.
        onSession?.(threadId)
      }

      turn = new Turn(threadId, roomId)
      // How this turn's approvals reach a human. Absent (standalone use, or a
      // caller that predates it) means every approval is declined.
      turn.ask = approval?.ask ?? null
      server.turns.set(threadId, turn)
      server.turnsByRoom.set(roomId, turn)

      // turn/start carries no developerInstructions, so anything conditional
      // (the room-rename nudge) rides on the prompt instead. CLA-128 owns
      // making this less awkward.
      await server.request('turn/start', {
        threadId,
        model,
        input: [{ type: 'text', text: prompt }],
      })

      // A turn that never ends would hold the room's `busy` flag forever, and
      // unlike the Claude path there is no child process for the OS to reap.
      // Interrupt on the way out so the thread is usable on the next message.
      const deadline = timeoutMs
        ? new Promise((resolve) => {
            timer = setTimeout(() => {
              this.cancel(roomId)
              resolve({ error: `codex: turn exceeded ${Math.round(timeoutMs / 1000)}s and was interrupted` })
            }, timeoutMs)
          })
        : null
      return await (deadline ? Promise.race([turn.done, deadline]) : turn.done)
    } catch (e) {
      return { error: `codex: ${e.message}` }
    } finally {
      if (timer) clearTimeout(timer)
      if (turn) {
        server.turns.delete(turn.threadId)
        server.turnsByRoom.delete(turn.roomId)
      }
    }
  },

  // Stops the turn in flight, if any. The server ends it with turn/completed,
  // so run() still resolves rather than hanging.
  cancel(roomId) {
    const turn = server.turnsByRoom.get(roomId)
    if (!turn?.turnId) return false
    try {
      server.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId })
      turn.interrupted = true
      return true
    } catch {
      return false
    }
  },
}
