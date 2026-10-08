import assert from 'node:assert/strict'
import { createSpawnGate, spawnCommand } from '../src/lib/spawnCommand.ts'

assert.equal(spawnCommand('claude'), '!spawn')
assert.equal(spawnCommand('codex'), '!spawn gpt-6.1-sol')
assert.throws(() => spawnCommand('other'), /provider/i)

const gate = createSpawnGate()
assert.equal(gate.begin(), true)
assert.equal(gate.begin(), false)
gate.end()
assert.equal(gate.begin(), true)

console.log('spawn command passed')
