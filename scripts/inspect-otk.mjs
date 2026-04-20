// Inspect a single /keys/claim response to see if server is serving fallback keys.
const HOMESERVER = process.env.HOMESERVER
const TOKEN = process.env.ACCESS_TOKEN
const user = process.argv[2] ?? process.env.USER_ID
const device = process.argv[3] ?? process.env.DEVICE_ID

const res = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ one_time_keys: { [user]: { [device]: 'signed_curve25519' } } }),
})
console.log('status', res.status)
console.log(JSON.stringify(await res.json(), null, 2))
