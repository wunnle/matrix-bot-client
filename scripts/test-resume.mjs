// Tests that persistent crypto stores survive a restart without fresh-login.
// Run 1: sender sends PING, receiver replies PONG — stores are written.
// Run 2: same devices, same stores, no re-login — repeat and verify it still works.
// A failure here means the app will break on every page reload.
//
// Setup: mints fresh devices once at the start so server OTKs match the new
// stores. Rounds 2 and 3 use the same stores (no re-login) — that's the resume.
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'

const repoRoot = process.cwd()
const envFile = path.resolve(repoRoot, 'scripts/.env')
const scriptFile = path.resolve(repoRoot, 'scripts/pingpong-side.mjs')
const freshLoginScript = path.resolve(repoRoot, 'scripts/fresh-login.mjs')

// Fresh devices + wipe stores so server OTKs match the new Olm accounts
console.log('Minting fresh devices…')
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [`--env-file=${envFile}`, freshLoginScript], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fresh-login exited ${code}`))))
})

// Use fixed store dirs (not cleared between rounds) to simulate restart
const storeDirA = path.resolve(repoRoot, 'scripts/.resume-store-sender')
const storeDirB = path.resolve(repoRoot, 'scripts/.resume-store-receiver')
fs.rmSync(storeDirA, { recursive: true, force: true })
fs.rmSync(storeDirB, { recursive: true, force: true })
fs.mkdirSync(storeDirA)
fs.mkdirSync(storeDirB)

function runSide(role, matchToken, label) {
  const storeDir = role === 'sender' ? storeDirA : storeDirB
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--env-file=${envFile}`, scriptFile],
      {
        env: { ...process.env, ROLE: role, MATCH_TOKEN: matchToken, STORE_DIR: storeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.stdout.on('data', (d) => process.stdout.write(`[${label}] `.replace(/\[.*?\] $/, '') + d))
    child.stderr.on('data', (d) => process.stderr.write(d))
    child.on('exit', (code) => resolve(code))
  })
}

async function runRound(n) {
  const matchToken = `resume-${n}-${Date.now()}`
  console.log(`\n=== Round ${n} (token=${matchToken}) ===`)
  const [codeA, codeB] = await Promise.all([
    runSide('sender', matchToken, `R${n}/sender`),
    runSide('receiver', matchToken, `R${n}/receiver`),
  ])
  console.log(`=== Round ${n}: sender=${codeA} receiver=${codeB} ===`)
  if (codeA !== 0 || codeB !== 0) {
    console.error(`Round ${n} FAILED`)
    process.exit(1)
  }
}

await runRound(1)
await runRound(2)
await runRound(3)

console.log('\nAll rounds passed — crypto store survives restarts.')
