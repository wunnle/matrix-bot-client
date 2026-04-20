// Logs in each test account with password to mint a brand-new device + access
// token. Writes them back to scripts/.env so later runs use fresh devices with
// clean server-side crypto state. The stale devices stay on the server but we
// stop referencing them, so their orphan OTKs/fallback keys become irrelevant.
import * as fs from 'node:fs'

const HOMESERVER = process.env.HOMESERVER
const ENV_PATH = 'scripts/.env'

async function login(user, password, label) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      initial_device_display_name: `construct test (${label})`,
    }),
  })
  if (!res.ok) throw new Error(`login ${label} failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return { userId: data.user_id, token: data.access_token, deviceId: data.device_id }
}

const a = await login(process.env.USER_ID, process.env.PASSWORD, 'A')
const b = await login(process.env.USER_ID_B, process.env.PASSWORD_B, 'B')
console.log('A:', a.userId, 'device:', a.deviceId)
console.log('B:', b.userId, 'device:', b.deviceId)

let env = fs.readFileSync(ENV_PATH, 'utf8')
function setVar(key, val) {
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (re.test(env)) env = env.replace(re, `${key}=${val}`)
  else env += `\n${key}=${val}`
}
setVar('ACCESS_TOKEN', a.token)
setVar('DEVICE_ID', a.deviceId)
setVar('ACCESS_TOKEN_B', b.token)
setVar('DEVICE_ID_B', b.deviceId)
fs.writeFileSync(ENV_PATH, env)
console.log('updated', ENV_PATH)
