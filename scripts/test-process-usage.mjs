import assert from 'node:assert/strict'
import { buildProcessGroups, parseProcStat, cpuPercent, serviceFromCgroup } from './process-usage.mjs'

const p = (pid, ppid, rssBytes = 10, extra = {}) => ({ pid, ppid, rssBytes, pssBytes: null, peakRssBytes: rssBytes, cpuTicks: 0, startTicks: pid, name: 'node', ...extra })
const groups = buildProcessGroups([p(1, 0), p(2, 1), p(3, 2), p(4, 1)], [
  { pid: 1, id: 'gateway', label: 'Shared gateway', roomIds: ['!a:x', '!b:x'], shared: true },
  { pid: 2, id: 'agent', label: 'Agent A', roomIds: ['!a:x'], shared: false },
])
assert.equal(groups.length, 2)
assert.deepEqual(groups.find(g => g.id === 'gateway').processes.map(p => p.pid), [1, 4])
assert.deepEqual(groups.find(g => g.id === 'agent').processes.map(p => p.pid), [2, 3])
assert.equal(groups.reduce((n, g) => n + g.rssBytes, 0), 40, 'nested process roots must not double-count descendants')
assert.deepEqual(groups.find(g => g.id === 'gateway').roomIds, ['!a:x', '!b:x'])
console.log('✓ nested process trees attributed once; shared rooms kept explicit')

const stat = `12 (a tricky ) process) S 4 0 0 0 0 0 0 0 0 0 20 10 0 0 0 0 0 0 200 0 0`
assert.deepEqual(parseProcStat(stat), { ppid: 4, cpuTicks: 30, startTicks: 200 })
assert.equal(cpuPercent(p(1, 0, 10, { cpuTicks: 200 }), p(1, 0, 10, { cpuTicks: 100 }), 1000, 100), 100)
assert.equal(cpuPercent(p(1, 0), p(1, 0, 10, { startTicks: 99 }), 1000, 100), null, 'reused PID starts a fresh CPU sample')
assert.equal(cpuPercent(p(1, 0), null, 1000, 100), null)
assert.deepEqual(buildProcessGroups([p(3, 9)], [{ pid: 9, id: 'gone' }]), [])
assert.equal(serviceFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/watchlist.service\n'), 'watchlist.service')
console.log('✓ proc stat parsing, interval CPU, PID reuse and exited roots')
