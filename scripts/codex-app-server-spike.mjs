#!/usr/bin/env node
// CLA-119 spike: drive `codex app-server` over JSON-RPC outside Matrix.
//
// Proves the round trip end to end: initialize -> thread/start -> turn/start,
// answering the resulting item/commandExecution/requestApproval first with
// `decline`, then re-asking and answering `accept`.
//
// Throwaway diagnostic. Every frame is logged raw so the wire shapes this
// version actually emits are visible, not the ones the schema implies.
//
//   node scripts/codex-app-server-spike.mjs [--quiet]
//
// --quiet drops the high-volume deltas (reasoning/agent message/output) from
// the log so the request/response skeleton is readable.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const QUIET = process.argv.includes('--quiet')

const NOISY = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/plan/delta',
  'thread/tokenUsage/updated',
])

const workdir = mkdtempSync(join(tmpdir(), 'codex-spike-'))

const child = spawn('codex', ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  // app-server dumps whole system prompts into stderr on model-refresh errors;
  // truncate so the log stays readable.
  for (const line of chunk.split('\n')) if (line.trim()) log('stderr', line.slice(0, 200))
})

const started = Date.now()
function log(dir, payload) {
  const ms = String(Date.now() - started).padStart(6)
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  console.log(`${ms}ms ${dir.padEnd(6)} ${body}`)
}

// --- framing ---------------------------------------------------------------
// stdio transport is newline-delimited JSON, one JSON-RPC message per line.
// No Content-Length headers (unlike LSP/MCP stdio).

let nextId = 1
const pending = new Map() // id -> {resolve, reject}
const notificationHandlers = new Set() // fn(msg) -> void
const serverRequestHandlers = new Map() // method -> fn(params, id) -> void

function send(msg) {
  log('-->', msg)
  child.stdin.write(JSON.stringify(msg) + '\n')
}

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

let buf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      log('raw', line)
      continue
    }
    handle(msg)
  }
})

function handle(msg) {
  const noisy = QUIET && NOISY.has(msg.method)
  if (!noisy) log('<--', msg)

  // Response to one of our requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = pending.get(msg.id)
    pending.delete(msg.id)
    if (!waiter) return
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
    else waiter.resolve(msg.result)
    return
  }

  // Server -> client request: has both id and method, needs a response.
  if (msg.id !== undefined && msg.method !== undefined) {
    const handler = serverRequestHandlers.get(msg.method)
    if (handler) handler(msg.params, msg.id)
    else {
      log('warn', `unhandled server request ${msg.method}; declining`)
      respond(msg.id, { decision: 'decline' })
    }
    return
  }

  // Notification.
  for (const fn of notificationHandlers) fn(msg)
}

function onNotification(fn) {
  notificationHandlers.add(fn)
  return () => notificationHandlers.delete(fn)
}

// Resolves when the current turn ends, either way.
function turnOutcome() {
  return new Promise((resolve) => {
    const off = onNotification((msg) => {
      if (msg.method === 'turn/completed' || msg.method === 'turn/failed' || msg.method === 'turn/aborted') {
        off()
        resolve(msg)
      }
    })
  })
}

// Any of these can carry the "may I run this?" question depending on how the
// model escalates, so wait on all of them rather than just the exec one.
const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/permissions/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]

function nextApproval() {
  return new Promise((resolve) => {
    for (const method of APPROVAL_METHODS) {
      serverRequestHandlers.set(method, (params, id) => {
        for (const m of APPROVAL_METHODS) serverRequestHandlers.delete(m)
        resolve({ method, params, id })
      })
    }
  })
}

const MARKER = 'cla119-spike-ok'
// A write under a read-only sandbox: the model cannot do this without asking
// for an escalation, which is exactly the approval round trip under test.
// (A plain `echo` is NOT enough — read-only lets it run unattended.)
const PROMPT =
  `Write the text ${MARKER} to a file called ${MARKER}.txt in the current working directory, ` +
  `using a single shell command. Do not ask me anything first, just attempt it.`

async function main() {
  await request('initialize', {
    clientInfo: { name: 'cla119-spike', title: 'CLA-119 spike', version: '0.0.0' },
  })
  // initialize is a request/response; `initialized` is a fire-and-forget
  // notification the server expects before it will do real work.
  notify('initialized', {})

  for (const [round, decision] of [
    ['round 1', 'decline'],
    ['round 2', 'accept'],
  ]) {
    log('info', `=== ${round}: will answer approvals with "${decision}" ===`)

    // Fresh thread per round on purpose: within one thread the model remembers
    // being declined and simply won't re-ask, so round 2 would see no approval.
    const thread = await request('thread/start', {
      cwd: workdir,
      // read-only + on-request is what forces the escalation. The sandbox lets
      // read-only commands run unattended, so only a write triggers the prompt.
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      ephemeral: true,
    })
    const threadId = thread.threadId ?? thread.thread?.id ?? thread.id
    log('info', `${round} threadId=${threadId}`)

    const approval = nextApproval()
    const done = turnOutcome()

    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: PROMPT }],
    })

    // Race: the model may finish the turn without ever asking (e.g. it decides
    // it cannot comply). Don't hang if no approval arrives.
    const got = await Promise.race([
      approval.then((a) => ({ kind: 'approval', ...a })),
      done.then((m) => ({ kind: 'turnEnd', msg: m })),
    ])

    if (got.kind === 'approval') {
      log(
        'info',
        `approval requested via ${got.method}: command=${JSON.stringify(got.params.command)} approvalId=${got.params.approvalId}`,
      )
      respond(got.id, { decision })
      const end = await done
      log('info', `${round} ended via ${end.method}`)
    } else {
      log('warn', `${round}: turn ended (${got.msg.method}) with no approval request`)
    }

    // Ground truth: did the decision actually gate the side effect?
    const wrote = existsSync(join(workdir, `${MARKER}.txt`))
    log('info', `${round}: ${MARKER}.txt exists = ${wrote} (expected ${decision === 'accept'})`)
  }

  log('info', 'done; shutting down')
  child.stdin.end()
  child.kill('SIGTERM')
  rmSync(workdir, { recursive: true, force: true })
}

main().catch((err) => {
  log('fatal', err.stack ?? String(err))
  child.kill('SIGKILL')
  rmSync(workdir, { recursive: true, force: true })
  process.exitCode = 1
})
