#!/usr/bin/env node
// Shows a dev server running on this Pi beside the chat in Construct. The
// sidebar runs on Sinan's phone or Mac, where localhost is that device, so the
// server goes on the tailnet instead: `tailscale serve` gives it an HTTPS
// address that only devices on Sinan's tailnet can reach (never Funnel, which
// would put it on the public internet), and construct-browse opens it.
//
//   construct-preview <port> [--title T] [--room !id] [-- <command…>]
//   construct-preview off <port>
//   construct-preview list
//
// With `-- <command…>` it also starts the dev server, as the user service
// construct-preview-<port>, so it outlives the agent session that started it
// (a server started by the session dies with it, and the tab shows a 502).
// The command runs in the current directory with this PATH and PORT=<port>;
// its output goes to ~/.cache/construct-preview/<port>.log. Running it again
// restarts the service. `off` stops the service and the tailnet address.
//
// Previews get forgotten, so each one ends itself: after --ttl (8h unless
// given; `none` to keep it), the timer construct-preview-expire-<port> runs
// `off`. A dev server that exits takes its tailnet address with it, so the
// tab shows an error rather than a 502 from serve.
//
// The address is https://<this machine>.<tailnet>.ts.net:<port + 10000>/ (or
// port − 10000 above 55535). Not the dev server's own port: serve listens on
// the tailnet addresses, which a dev server counts as its port being taken. A
// dev server that checks the Host header refuses that name until allowed;
// this checks for that and says what to set.
//
// Needs, once: HTTPS certificates enabled for the tailnet (admin console, DNS
// page) and this user allowed to configure serve (sudo tailscale set
// --operator=$USER). The command says which is missing.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HELP = `Usage:
  construct-preview <port> [--title T] [--room !id] [--ttl 8h] [-- <command…>]
      Serve localhost:<port> on the tailnet (HTTPS, tailnet only, at port
      <port>+10000) and open it beside the chat.
      With -- <command…>, first start the dev server as the
      user service construct-preview-<port>, which outlives this session.
      e.g. construct-preview 5173 -- npm run dev -- --port 5173 --strictPort
      --ttl: stop it all after this long (30m, 2h…; default 8h; none to keep)
  construct-preview off <port>   stop the service and the tailnet address
  construct-preview list         what is served, and the services running

Dev servers that check the Host header must allow the tailnet name:
  Vite:    server: { allowedHosts: ['.ts.net'] } in vite.config
  webpack: devServer: { allowedHosts: ['.ts.net'] }`

const argv = process.argv.slice(2)
const dash = argv.indexOf('--')
const args = dash < 0 ? argv : argv.slice(0, dash)
const command = dash < 0 ? null : argv.slice(dash + 1)
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(HELP)
  process.exit(args.length ? 0 : 1)
}
const LOG_DIR = path.join(os.homedir(), '.cache', 'construct-preview')
const unitFor = (port) => `construct-preview-${port}`
const expiryFor = (port) => `construct-preview-expire-${port}`
const logFor = (port) => path.join(LOG_DIR, `${port}.log`)
// The tailnet port for a dev server's port; see the top of the file.
const tailnetPort = (port) => (port <= 55535 ? port + 10000 : port - 10000)

if (args[0] === 'list') {
  const { stdout } = await tailscale(['serve', 'status'])
  console.log(stdout.trim() || 'Nothing is being served.')
  const units = await systemctl(['list-units', 'construct-preview-[0-9]*', '--all', '--no-legend', '--plain'])
  console.log(units.trim() ? `\nServices:\n${units.trim()}\nLogs: ${LOG_DIR}/<port>.log` : '\nNo construct-preview services.')
  const timers = await systemctl(['list-timers', 'construct-preview-expire-*', '--all', '--no-legend'])
  if (timers.trim()) console.log(`\nStops by itself (next, left, …, unit):\n${timers.trim()}`)
  process.exit(0)
}

if (args[0] === 'off') {
  const port = portArg(args[1])
  await stopExpiry(port)
  const served = await tailscale(['serve', `--https=${tailnetPort(port)}`, 'off'], { tolerant: true })
  const stopped = await stopService(port)
  console.log([
    served ? `Stopped serving port ${port} on the tailnet (:${tailnetPort(port)}).` : `Port ${port} wasn't served on the tailnet.`,
    stopped ? `Stopped the service ${unitFor(port)}.` : null,
  ].filter(Boolean).join(' '))
  process.exit(0)
}

const port = portArg(args[0])
const rest = args.slice(1)
const ttlAt = rest.indexOf('--ttl')
const ttl = ttlAt < 0 ? '8h' : rest.splice(ttlAt, 2)[1]
if (!/^(none|\d+[smh])$/.test(ttl ?? '')) die(`--ttl takes a duration like 30m or 8h, or none (got ${ttl ?? 'nothing'}).`)
if (command && !command.length) die('Nothing after --: give the command that starts the dev server.')

// Check Tailscale before starting anything, so a missing prerequisite doesn't
// leave a server running for nothing.
const { stdout: statusJson } = await tailscale(['status', '--json'])
const status = JSON.parse(statusJson)
const host = status.Self?.DNSName?.replace(/\.$/, '')
if (!host) die('This machine has no tailnet name; is Tailscale up?')
if (!status.CertDomains?.length) {
  die('HTTPS certificates are off for the tailnet, and Construct (an https page) can only frame https. ' +
    'Ask Sinan to enable "HTTPS Certificates" in the Tailscale admin console (DNS page).')
}

await stopExpiry(port)
if (command) await startService(port, command)

// Something has to be answering locally, or the tab shows a 502. Vite and
// others listen on "localhost", which Node may bind to ::1 only; serve's
// target is "localhost" for that reason (it drops the brackets of [::1]).
const answering = await localTarget(port, command ? 90_000 : 3_000)
const target = `http://localhost:${port}`
if (!answering) {
  die(command
    ? `${unitFor(port)} is running but nothing answers on port ${port} after 90s. Is the command using that port?\n${logTail(port)}`
    : `Nothing answers on port ${port}. Start the dev server first, or pass it after --.`)
}

await tailscale(['serve', '--bg', '--yes', `--https=${tailnetPort(port)}`, target])
const url = `https://${host}:${tailnetPort(port)}/`
console.log(`Serving ${answering.replace('http://', '')} on the tailnet at ${url}`)

// Fetch it the way the tab will. The server sees the tailnet name in the Host
// header, which a host check refuses; then the tab would show only that.
const problem = await tailnetProblem(url)
if (problem?.host) {
  die(`The dev server refuses the tailnet name (${problem.host}), so the tab would only show that error. Allow it, then run this again:\n` +
    '  Vite:    server: { allowedHosts: [\'.ts.net\'] } in vite.config\n' +
    '  webpack: devServer: { allowedHosts: [\'.ts.net\'] }\n' +
    'Others: allow the host ' + host + '.')
}
if (problem) die(`${url} answers ${problem.other}, so it isn't opened. The tailnet address stays; fix it and run this again, or construct-preview off ${port}.`)

// Open it the same way an agent opens any page.
const browse = path.join(import.meta.dirname, 'construct-browse.mjs')
try {
  const { stdout } = await run(process.execPath, [browse, url, ...rest])
  process.stdout.write(stdout)
} catch (e) {
  die(e.stderr?.trim() || e.message)
}
if (command) console.log(`The server runs as ${unitFor(port)}.`)
if (ttl === 'none') console.log(`It stays until: construct-preview off ${port}`)
else {
  await startExpiry(port, ttl)
  console.log(`It all stops by itself in ${ttl}, or now with: construct-preview off ${port}`)
}
// The agent can't see the tab; the Pi is on the tailnet, so it can look.
console.log(`See what Sinan sees: page shot ${url} --width 390 --height 844`)

async function startService(port, command) {
  await stopService(port)
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.writeFileSync(logFor(port), '')
  try {
    await run('systemd-run', [
      '--user', '--collect', '--quiet', `--unit=${unitFor(port)}`,
      `--working-directory=${process.cwd()}`,
      `--setenv=PATH=${process.env.PATH}`, `--setenv=PORT=${port}`,
      '-p', `StandardOutput=append:${logFor(port)}`, '-p', `StandardError=append:${logFor(port)}`,
      // However it stops, the tailnet address goes too ("-": it may be gone already).
      '-p', `ExecStopPost=-${tailscaleBin()} serve --https=${tailnetPort(port)} off`,
      '--', ...command,
    ], { timeout: 20_000 })
  } catch (e) {
    die(`Couldn't start ${unitFor(port)}: ${(e.stderr || e.message).trim()}`)
  }
  console.log(`Started ${command.join(' ')} as ${unitFor(port)} (log: ${logFor(port)})`)
}

// The timer that runs `off` once the preview's time is up.
async function startExpiry(port, ttl) {
  try {
    await run('systemd-run', [
      '--user', '--collect', '--quiet', `--unit=${expiryFor(port)}`,
      `--on-active=${ttl}`, '--timer-property=AccuracySec=1s',
      `--setenv=PATH=${process.env.PATH}`,
      process.execPath, import.meta.filename, 'off', String(port),
    ], { timeout: 20_000 })
  } catch (e) {
    console.error(`Couldn't set the ${ttl} limit (${(e.stderr || e.message).trim()}); stop it with construct-preview off ${port}.`)
  }
}

async function stopExpiry(port) {
  await systemctl(['stop', `${expiryFor(port)}.timer`])
  await systemctl(['reset-failed', `${expiryFor(port)}.timer`, `${expiryFor(port)}.service`])
}

// systemd wants an absolute path for ExecStopPost.
function tailscaleBin() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, 'tailscale')
    if (dir && fs.existsSync(p)) return p
  }
  return '/usr/bin/tailscale'
}

// True when there was a service to stop.
async function stopService(port) {
  const state = (await systemctl(['is-active', unitFor(port)])).trim()
  if (state === 'inactive' || state === 'unknown' || !state) {
    await systemctl(['reset-failed', unitFor(port)])
    return false
  }
  await systemctl(['stop', unitFor(port)])
  await systemctl(['reset-failed', unitFor(port)])
  return true
}

// The local address that answers on the port, waiting up to `ms`; null if none.
// Gives up early when the service it started has exited.
async function localTarget(port, ms) {
  const until = Date.now() + ms
  for (;;) {
    for (const h of ['127.0.0.1', '[::1]']) {
      try {
        await fetch(`http://${h}:${port}/`, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
        return `http://${h}:${port}`
      } catch { /* not this one */ }
    }
    if (command) {
      const state = (await systemctl(['is-active', unitFor(port)])).trim()
      if (state === 'failed' || state === 'inactive') {
        die(`The dev server exited (${unitFor(port)} is ${state}).\n${logTail(port)}`)
      }
    }
    if (Date.now() >= until) return null
    await new Promise((r) => setTimeout(r, 500))
  }
}

// Why the tailnet address won't show the page, or null when it answers fine:
// { host } when a dev server's host check refuses the tailnet name, { other }
// for any other error status (a 502 from serve, a 500 from the app).
async function tailnetProblem(url) {
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' })
  } catch (e) {
    return { other: `nothing (${e.cause?.code ?? e.name})` }
  }
  if (res.ok || (res.status >= 300 && res.status < 400)) return null
  const body = (await res.text().catch(() => '')).slice(0, 4000)
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (/Blocked request\. This host .* is not allowed/i.test(body)) return { host: `Vite: "${res.status} Blocked request"` }
  if (/Invalid Host header/i.test(body)) return { host: `webpack: "${res.status} Invalid Host header"` }
  if (/host.{0,40}not allowed|disallowed host|invalid host/i.test(body)) return { host: `${res.status}: ${text}` }
  return { other: `${res.status}${text ? `: ${text}` : ''}` }
}

function logTail(port) {
  try {
    const lines = fs.readFileSync(logFor(port), 'utf8').trimEnd().split('\n').slice(-20).join('\n')
    return lines ? `Last lines of ${logFor(port)}:\n${lines}` : `${logFor(port)} is empty.`
  } catch { return `No log at ${logFor(port)}.` }
}

function portArg(s) {
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1 || n > 65535) die(`Not a port: ${s ?? '(none)'}\n${HELP}`)
  return n
}

// stdout, or '' when systemctl exits non-zero (is-active does for "inactive").
async function systemctl(argv) {
  try {
    return (await run('systemctl', ['--user', ...argv], { timeout: 20_000 })).stdout
  } catch (e) {
    return e.stdout ?? ''
  }
}

// With `tolerant`, a failure returns null instead of exiting.
async function tailscale(argv, { tolerant = false } = {}) {
  try {
    return await run('tailscale', argv, { timeout: 20_000 })
  } catch (e) {
    const err = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || e.message
    if (/access denied|permission|operator/i.test(err)) {
      die(`tailscale ${argv[0]} needs permission. Ask Sinan to run once: sudo tailscale set --operator=${process.env.USER}\n(${err})`)
    }
    if (tolerant) return null
    die(`tailscale ${argv.join(' ')} failed: ${err}`)
  }
}

function die(msg) {
  console.error(msg)
  process.exit(1)
}
