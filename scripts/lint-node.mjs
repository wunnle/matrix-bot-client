// `npm run lint:node`: ESLint's undefined-name check over the bot and the Vercel
// functions (see the Node block in eslint.config.js). Agent worktrees usually
// have no node_modules, and the rest of `npm test` runs there on plain node, so
// without ESLint this says so and steps aside rather than failing the suite.
// The deploy runs `npm test` in ~/matrix-pwa, which has it, so it still gates.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.join(import.meta.dirname, '..')
const eslint = path.join(root, 'node_modules', '.bin', 'eslint')
if (!fs.existsSync(eslint)) {
  console.log('lint:node skipped: no node_modules here (it runs in ~/matrix-pwa before a deploy)')
  process.exit(0)
}
const run = spawnSync(eslint, ['scripts', 'api'], { cwd: root, stdio: 'inherit' })
if (run.status === 0) console.log('lint:node: ok')
process.exit(run.status ?? 1)
