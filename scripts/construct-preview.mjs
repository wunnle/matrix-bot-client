#!/usr/bin/env node
// Shows a dev server running on this Pi beside the chat in Construct. The
// sidebar runs on Sinan's phone or Mac, where localhost is that device, so the
// server goes on the tailnet instead: `tailscale serve` gives it an HTTPS
// address that only devices on Sinan's tailnet can reach (never Funnel, which
// would put it on the public internet), and construct-browse opens it.
//
//   construct-preview <port> [--title T] [--room !id]   serve and open it
//   construct-preview off <port>                        stop serving it
//   construct-preview list                              what's being served
//
// The address is https://<this machine>.<tailnet>.ts.net:<port>/, the same
// port as the dev server. Dev servers that check the Host header need to allow
// it: for Vite, server.allowedHosts: ['.ts.net'] (or --host plus that).
//
// Needs, once: HTTPS certificates enabled for the tailnet (admin console, DNS
// page) and this user allowed to configure serve (sudo tailscale set
// --operator=$USER). The command says which is missing.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const args = process.argv.slice(2)
const HELP = 'Usage: construct-preview <port> [--title T] [--room !id] | off <port> | list'
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(HELP)
  process.exit(args.length ? 0 : 1)
}

if (args[0] === 'list') {
  const { stdout } = await tailscale(['serve', 'status'])
  console.log(stdout.trim() || 'Nothing is being served.')
  process.exit(0)
}

if (args[0] === 'off') {
  const port = portArg(args[1])
  await tailscale(['serve', `--https=${port}`, 'off'])
  console.log(`Stopped serving port ${port} on the tailnet.`)
  process.exit(0)
}

const port = portArg(args[0])
const rest = args.slice(1)

// Something has to be answering locally first, or the tab shows a 502.
try {
  await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000), redirect: 'manual' })
} catch {
  die(`Nothing answers on 127.0.0.1:${port}. Start the dev server first.`)
}

const { stdout: statusJson } = await tailscale(['status', '--json'])
const status = JSON.parse(statusJson)
const host = status.Self?.DNSName?.replace(/\.$/, '')
if (!host) die('This machine has no tailnet name; is Tailscale up?')
if (!status.CertDomains?.length) {
  die('HTTPS certificates are off for the tailnet, and Construct (an https page) can only frame https. ' +
    'Ask Sinan to enable "HTTPS Certificates" in the Tailscale admin console (DNS page).')
}

await tailscale(['serve', '--bg', '--yes', `--https=${port}`, `http://127.0.0.1:${port}`])
const url = `https://${host}:${port}/`
console.log(`Serving 127.0.0.1:${port} on the tailnet at ${url}`)

// Open it the same way an agent opens any page.
const browse = path.join(import.meta.dirname, 'construct-browse.mjs')
try {
  const { stdout } = await run(process.execPath, [browse, url, ...rest])
  process.stdout.write(stdout)
} catch (e) {
  die(e.stderr?.trim() || e.message)
}

function portArg(s) {
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1 || n > 65535) die(`Not a port: ${s ?? '(none)'}\n${HELP}`)
  return n
}

async function tailscale(argv) {
  try {
    return await run('tailscale', argv, { timeout: 20_000 })
  } catch (e) {
    const err = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || e.message
    if (/access denied|permission|operator/i.test(err)) {
      die(`tailscale ${argv[0]} needs permission. Ask Sinan to run once: sudo tailscale set --operator=${process.env.USER}\n(${err})`)
    }
    die(`tailscale ${argv.join(' ')} failed: ${err}`)
  }
}

function die(msg) {
  console.error(msg)
  process.exit(1)
}
