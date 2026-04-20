// Orchestrator: spawns two child processes (sender + receiver) so each has its
// own module-level Matrix client and its own persistent crypto store.
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'

const matchToken = Date.now().toString()
const repoRoot = process.cwd()
const envFile = path.resolve(repoRoot, 'scripts/.env')
const scriptFile = path.resolve(repoRoot, 'scripts/pingpong-side.mjs')

function runSide(role) {
  const storeDir = path.resolve(repoRoot, `scripts/.pingpong-store-${role}`)
  fs.mkdirSync(storeDir, { recursive: true })
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--env-file=${envFile}`, scriptFile],
      {
        env: { ...process.env, ROLE: role, MATCH_TOKEN: matchToken, STORE_DIR: storeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.stdout.on('data', (d) => process.stdout.write(d))
    child.stderr.on('data', (d) => process.stderr.write(d))
    child.on('exit', (code) => resolve(code))
  })
}

const [codeA, codeB] = await Promise.all([runSide('sender'), runSide('receiver')])
console.log(`\n=== sender exit=${codeA}  receiver exit=${codeB} ===`)
process.exit(codeA === 0 && codeB === 0 ? 0 : 1)
