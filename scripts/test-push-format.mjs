// Push formatting shared by the homeserver gateway and the bot's own pushes for
// encrypted rooms (api/_push.js, api/_bot-push.js), plus the gateway's routing
// of encrypted homeserver pushes to a badge-only update.
// Run: node scripts/test-push-format.mjs
import assert from 'node:assert/strict'

// A fake homeserver for the bot path; anything it doesn't know fails, which
// the gateway treats as "nobody in the foreground", "no avatar", "not seen
// before".
process.env.INTENT_SECRET = 'test-secret'
process.env.MATRIX_ACCESS_TOKEN = 'owner-token'
delete process.env.APNS_KEY_ID
const OWNER = '@wunnle:matrix.org'
const fake = { events: {}, pushers: [], rules: { global: { override: [], room: [] } } }
const calls = []
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  calls.push(`${init.method ?? 'GET'} ${u.pathname}`)
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
  if (u.pathname.endsWith('/account/whoami')) return json(200, { user_id: OWNER })
  const ev = u.pathname.match(/\/rooms\/([^/]+)\/event\/([^/]+)$/)
  if (ev) {
    const e = fake.events[decodeURIComponent(ev[2])]
    return e ? json(200, e) : json(404, { errcode: 'M_NOT_FOUND' })
  }
  if (u.pathname.endsWith('/pushers')) return json(200, { pushers: fake.pushers })
  if (u.pathname.endsWith('/pushrules/')) return json(200, fake.rules)
  throw new Error('offline in tests')
}

const { apnsPayloadFor, webPushPayloadFor, suppressReason, stripMarkdown, parseActions, deliver } =
  await import('../api/_push.js')
const { mutedByRules } = await import('../api/_bot-push.js')
const { default: gateway } = await import('../api/matrix-push.js')

// ── Formatting ────────────────────────────────────────────────────────────
const content = { msgtype: 'm.text', body: 'Deploy is **green** for `snake_case_id`.\n\nShip it?\n\n[[Ship it]] [[Wait]]' }
const n = {
  room_id: '!r:matrix.org', room_name: 'Colonist Bot', event_id: '$e',
  sender: '@bender-2:matrix.org', sender_display_name: 'Bender', content,
}
const p = apnsPayloadFor(n, 'https://x/avatar')
assert.equal(p.aps.alert.title, 'Colonist Bot', 'agent bot pushes are titled by room')
assert.equal(p.aps.alert.subtitle, undefined)
assert.equal(p.aps.alert.body, 'Deploy is green for snake_case_id.\n\nShip it?')
assert.deepEqual(p.actions, ['Ship it', 'Wait'])
assert.equal(p.md, 'Deploy is **green** for `snake_case_id`.\n\nShip it?')
assert.equal(p.aps.category, 'MESSAGE')
assert.equal(p.aps['mutable-content'], 1)
assert.equal(p.aps['thread-id'], '!r:matrix.org')
assert.equal(p.roomId, '!r:matrix.org')
assert.equal(p.avatarUrl, 'https://x/avatar')
assert.ok(!('badge' in p.aps), 'no counts → badge left alone')
assert.equal(apnsPayloadFor({ ...n, counts: { unread: 3 } }, null).aps.badge, 3)

const human = apnsPayloadFor({ ...n, sender: '@someone:matrix.org', sender_display_name: 'Ayse' }, null)
assert.equal(human.aps.alert.title, 'Ayse')
assert.equal(human.aps.alert.subtitle, 'Colonist Bot')

assert.deepEqual(webPushPayloadFor(n, null), {
  title: 'Colonist Bot', body: 'Deploy is green for snake_case_id.\n\nShip it?', roomId: '!r:matrix.org', icon: null, unread: null,
})
assert.equal(stripMarkdown('5 * 3 = 15 and 2 * 4'), '5 * 3 = 15 and 2 * 4')
assert.deepEqual(parseActions('see [[label]]').actions, [])

// ── What never notifies ───────────────────────────────────────────────────
assert.equal(suppressReason(content), null)
assert.equal(suppressReason({ body: '🔧 Bash: "ls"', 'com.construct.machine': { kind: 'notification' } }), 'machine')
assert.equal(suppressReason({ body: '🔧 Bash: "npm test"\n📖 Read: "src/a.ts"' }), 'thinking')
assert.equal(suppressReason({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' }), 'no body')
assert.deepEqual(await deliver({ ...n, content: { body: '🔧 Bash: "ls"' }, devices: [{ pushkey: 'tok' }] }),
  { rejected: [], suppressed: 'thinking' })

// ── Owner's push rules on the bot path ────────────────────────────────────
const room = '!r:matrix.org'
assert.equal(mutedByRules({ override: [], room: [] }, room), false)
assert.equal(mutedByRules(undefined, room), false, 'unreadable rules fail open')
assert.equal(mutedByRules({ override: [{ rule_id: '.m.rule.master', enabled: true, actions: [] }] }, room), true)
assert.equal(mutedByRules({ override: [{ rule_id: '.m.rule.master', enabled: false, actions: [] }] }, room), false)
assert.equal(mutedByRules({ override: [{ rule_id: room, enabled: true, actions: [] }] }, room), true, 'muted room')
assert.equal(mutedByRules({ room: [{ rule_id: room, enabled: true, actions: ['dont_notify'] }] }, room), true, 'mentions only')
assert.equal(mutedByRules({ room: [{ rule_id: room, enabled: true, actions: ['notify', { set_tweak: 'sound', value: 'default' }] }] }, room), false)
assert.equal(mutedByRules({ room: [{ rule_id: '!other:matrix.org', enabled: true, actions: [] }] }, room), false)

// ── Gateway routing ───────────────────────────────────────────────────────
function call(body, query = {}, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this },
      json(b) { resolve({ status: this.statusCode, body: b }) },
      end() { resolve({ status: this.statusCode }) },
    }
    gateway({ method: 'POST', body, query, headers }, res)
  })
}
// Encrypted homeserver push: no text, so no alert — only a badge (APNs is
// unconfigured here, so nothing is actually sent).
assert.deepEqual(await call({ notification: {
  type: 'm.room.encrypted', room_id: room, event_id: '$x', content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' },
  counts: { unread: 2 }, devices: [{ pushkey: 'tok' }],
} }), { status: 200, body: { rejected: [] } })
// The bot route refuses callers without the shared secret.
assert.equal((await call({ room_id: room, event_id: '$x', content }, { from: 'bot' })).status, 401)

// ── Bot path end to end (against the fake homeserver) ─────────────────────
const bot = (event_id, body = content) =>
  call({ room_id: room, event_id, content: body, room_name: 'Colonist Bot' }, { from: 'bot' }, { 'x-intent-secret': 'test-secret' })
fake.pushers = [
  { kind: 'http', app_id: 'com.wunnle.construct.ios', pushkey: 'apns-token', data: { url: 'https://construct.kafagoz.com/_matrix/push/v1/notify' } },
  { kind: 'http', app_id: 'im.vector.app', pushkey: 'element', data: { url: 'https://sygnal.example/_matrix/push/v1/notify' } },
]
fake.events.$enc = { type: 'm.room.encrypted', sender: '@bender-2:matrix.org', content: { algorithm: 'm.megolm.v1.aes-sha2' } }
fake.events.$plain = { type: 'm.room.message', sender: '@bender-2:matrix.org', content }
fake.events.$mine = { type: 'm.room.encrypted', sender: OWNER, content: {} }

let r = await bot('$enc')
assert.equal(r.status, 200)
assert.deepEqual(r.body, { sent: true, devices: 1, rejected: 0 }, 'only pushers on this gateway are used')
assert.ok(calls.some((c) => c.includes('/event/')), 'the event is checked on the homeserver')

r = await bot('$plain')
assert.equal(r.body.sent, false)
assert.match(r.body.reason, /not encrypted/, 'plaintext events already got the homeserver push')

assert.match((await bot('$mine')).body.reason, /own message/)
assert.equal((await bot('$missing')).status, 404)
assert.equal((await bot('$enc', { body: '🔧 Bash: "ls"' })).body.reason, 'thinking')

fake.rules.global.override.push({ rule_id: room, enabled: true, actions: [] })
assert.equal((await bot('$enc')).body.reason, 'room muted')
fake.rules.global.override = []

fake.pushers = []
assert.equal((await bot('$enc')).body.reason, 'no devices')

console.log('push format: ok')
