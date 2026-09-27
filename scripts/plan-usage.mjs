// How much of the Claude plan is left, account-wide.
//
// The quota is per account, not per room, and only this host holds the login —
// so the bot reads it here and Construct just displays what it is handed. This
// is the endpoint Claude Code's own /usage reads.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

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
  const breakdown = (body.seven_day_breakdown?.rows ?? [])
    .filter((r) => typeof r.percent === 'number' && r.display_name)
    .map((r) => ({ name: String(r.display_name), percent: Math.round(r.percent) }))
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

  return { session, weekly, models, breakdown, extra, fetchedAt: Date.now() }
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
