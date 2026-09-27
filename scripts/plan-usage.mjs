// How much of the Claude and Codex plans is left, account-wide.
//
// The quota is per account, not per room, and only this host holds the logins —
// so the bot reads it here and Construct just displays what it is handed. For
// Claude this is the endpoint Claude Code's own /usage reads; for Codex it is
// the CLI's own app-server.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/**
 * @returns {Promise<{session: Window | null, weekly: Window | null, fetchedAt: number}>}
 *   where Window is {percent, resetsAt}. Throws when there is nothing to report.
 *
 * The token is only read, never refreshed: the CLI owns the refresh, and doing
 * it here would rotate the refresh token out from under a running agent. An
 * expired token just means a skipped poll until the next turn renews it.
 */
export async function fetchPlanUsage() {
  const oauth = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'))?.claudeAiOauth
  if (!oauth?.accessToken) throw new Error('no Claude login on this host')
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) throw new Error('Claude token expired, waiting for the CLI to refresh it')

  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`usage endpoint answered ${res.status}`)
  const body = await res.json()

  const window = (w) => (w && typeof w.utilization === 'number'
    ? { percent: Math.round(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null }
    : null)
  const session = window(body.five_hour)
  const weekly = window(body.seven_day)
  if (!session && !weekly) throw new Error('usage endpoint returned no windows')

  // Per-model weekly caps only exist on some plans; the endpoint sends null
  // for the rest, and those are dropped rather than drawn as empty bars.
  const models = Object.fromEntries(
    [['opus', body.seven_day_opus], ['sonnet', body.seven_day_sonnet]]
      .map(([name, w]) => [name, window(w)])
      .filter(([, w]) => w),
  )
  const x = body.extra_usage
  const extra = x ? {
    enabled: !!x.is_enabled,
    used: typeof x.used_credits === 'number' ? x.used_credits : null,
    limit: typeof x.monthly_limit === 'number' ? x.monthly_limit : null,
    currency: typeof x.currency === 'string' ? x.currency : null,
    // used/limit are minor units (2000 with 2 decimal places is $20.00).
    exponent: typeof x.decimal_places === 'number' ? x.decimal_places : 2,
    disabledReason: typeof x.disabled_reason === 'string' ? x.disabled_reason : null,
  } : null

  return { session, weekly, models, extra, fetchedAt: Date.now() }
}

/**
 * Codex's limits, asked of `codex app-server` the way its own TUI does.
 *
 * Going through the CLI rather than calling the ChatGPT backend directly means
 * Codex keeps owning its login: it refreshes the token itself, and this file
 * never reads or sends it. The cost is a short-lived process per poll.
 *
 * @returns {Promise<{windows: {minutes, percent, resetsAt}[], plan, resetCredits, fetchedAt}>}
 */
export function fetchCodexUsage({ timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      err ? reject(err) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('codex app-server did not answer')), timeoutMs)
    child.on('error', (e) => finish(new Error(`could not start codex: ${e.message}`)))
    child.on('exit', () => finish(new Error('codex app-server exited early')))

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== 2) continue
        if (msg.error) return finish(new Error(`codex: ${msg.error.message ?? 'rate limit read failed'}`))
        const rl = msg.result?.rateLimits
        const windows = [rl?.primary, rl?.secondary]
          .filter((w) => w && typeof w.usedPercent === 'number')
          .map((w) => ({
            minutes: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
            percent: Math.round(w.usedPercent),
            resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
          }))
          // Shortest window first: it is the one that stops work soonest.
          .sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity))
        if (!windows.length) return finish(new Error('codex reported no rate-limit windows'))
        const resetCredits = (msg.result?.rateLimitResetCredits?.credits ?? [])
          .filter((c) => c.status === 'available').length
        finish(null, {
          windows,
          plan: typeof rl.planType === 'string' ? rl.planType : null,
          resetCredits,
          fetchedAt: Date.now(),
        })
      }
    })

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'construct-usage', title: 'Construct usage', version: '1' } } })
    send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' })
  })
}

/** sameUsage for Codex readings. */
export function sameCodexUsage(a, b) {
  if (!a || !b || a.windows.length !== b.windows.length || a.resetCredits !== b.resetCredits) return false
  return a.windows.every((w, i) => w.percent === b.windows[i].percent &&
    Math.round((w.resetsAt ?? 0) / 60000) === Math.round((b.windows[i].resetsAt ?? 0) / 60000))
}

/**
 * Whether two readings would draw the same meter. Reset times drift by
 * fractions of a second between calls, so they are compared to the minute.
 */
export function sameUsage(a, b) {
  if (!a || !b) return false
  const same = (x, y) => x?.percent === y?.percent &&
    Math.round((x?.resetsAt ?? 0) / 60000) === Math.round((y?.resetsAt ?? 0) / 60000)
  return same(a.session, b.session) && same(a.weekly, b.weekly)
}
