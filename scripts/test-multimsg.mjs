// Sends N messages in sequence between two accounts and verifies all decrypt.
// Tests that megolm ratchet advances correctly across multiple messages.
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'

const repoRoot = process.cwd()
const envFile = path.resolve(repoRoot, 'scripts/.env')
const freshLoginScript = path.resolve(repoRoot, 'scripts/fresh-login.mjs')

const MSG_COUNT = Number(process.env.MSG_COUNT ?? 10)

console.log(`Minting fresh devices…`)
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [`--env-file=${envFile}`, freshLoginScript], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fresh-login exited ${code}`))))
})

const storeDirA = path.resolve(repoRoot, 'scripts/.multimsg-store-A')
const storeDirB = path.resolve(repoRoot, 'scripts/.multimsg-store-B')
fs.rmSync(storeDirA, { recursive: true, force: true })
fs.rmSync(storeDirB, { recursive: true, force: true })
fs.mkdirSync(storeDirA)
fs.mkdirSync(storeDirB)

// Run both sides in-process with separate module-level state via worker threads
// would be complex — instead use a custom script for multi-message exchange.
const scriptFile = path.resolve(repoRoot, 'scripts/multimsg-side.mjs')

function runSide(role, label) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--env-file=${envFile}`, scriptFile],
      {
        env: {
          ...process.env,
          ROLE: role,
          MSG_COUNT: String(MSG_COUNT),
          STORE_DIR: role === 'A' ? storeDirA : storeDirB,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.stdout.on('data', (d) => process.stdout.write(d))
    child.stderr.on('data', (d) => process.stderr.write(d))
    child.on('exit', (code) => resolve(code))
  })
}

console.log(`\nRunning ${MSG_COUNT}-message exchange…`)
const [codeA, codeB] = await Promise.all([runSide('A', 'A'), runSide('B', 'B')])
console.log(`\n=== A exit=${codeA}  B exit=${codeB} ===`)
process.exit(codeA === 0 && codeB === 0 ? 0 : 1)
