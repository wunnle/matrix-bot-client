// Drains leftover signed_curve25519 OTKs from matrix.org for the test devices.
// Previous runs with in-memory fake-indexeddb uploaded OTKs whose private keys
// are now gone. This script claims (consumes) them so the server stops
// returning "already exists" on new uploads from our persistent store.
const HOMESERVER = process.env.HOMESERVER
const TOKEN = process.env.ACCESS_TOKEN // any valid token works — claim is cross-user

const targets = [
  { user: process.env.USER_ID, device: process.env.DEVICE_ID },
  { user: process.env.USER_ID_B, device: process.env.DEVICE_ID_B },
]

async function claim(user, device) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ one_time_keys: { [user]: { [device]: 'signed_curve25519' } } }),
  })
  if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const dev = data?.one_time_keys?.[user]?.[device]
  if (!dev || Object.keys(dev).length === 0) return null
  return Object.keys(dev)[0]
}

for (const { user, device } of targets) {
  if (!user || !device) continue
  let n = 0
  while (true) {
    const keyId = await claim(user, device)
    if (!keyId) break
    n++
    if (n % 10 === 0) console.log(`  ${user}/${device}: drained ${n}…`)
  }
  console.log(`${user}/${device}: drained ${n} OTK(s)`)
}

console.log('done')
