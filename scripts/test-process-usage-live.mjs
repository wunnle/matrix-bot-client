import assert from 'node:assert/strict'
import { createProcessSampler } from './process-usage.mjs'
const sample = createProcessSampler()
const start = performance.now()
const first = sample()
await new Promise(r => setTimeout(r, 1100))
const result = sample()
assert.ok(result.host.totalBytes > 0)
assert.ok(result.groups.length > 0)
const pids = result.groups.flatMap(g => g.processes.map(p => p.pid))
assert.equal(pids.length, new Set(pids).size, 'each PID counted once')
assert.ok(result.groups.some(g => g.processes.some(p => p.cpuPercent !== null)), 'surviving processes have interval CPU; newly started ones may still be warming up')
const payload = JSON.stringify(result)
assert.ok(!payload.includes('cmdline') && !payload.includes('access_token') && !payload.includes('prompt'))
console.log(JSON.stringify({ durationMs: Math.round(performance.now() - start - 1100), payloadBytes: Buffer.byteLength(payload), host: result.host,
 groups: result.groups.map(({label,roomIds,rssBytes,pssBytes,cpuPercent,processes}) => ({label,roomIds,rssBytes,pssBytes,cpuPercent,processes: processes.length})), firstSampleGroups: first.groups.length }, null, 2))
