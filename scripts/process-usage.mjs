// Linux process accounting for Usage. Never publish argv, environment, paths or prompts.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

export function serviceFromCgroup(text) {
  return text.split(/[\/\n]/).filter(s => s.endsWith('.service')).at(-1) ?? null
}

export function parseProcStat(text) {
  const end = text.lastIndexOf(')')
  const fields = text.slice(end + 2).trim().split(/\s+/)
  return { ppid: Number(fields[1]), cpuTicks: Number(fields[11]) + Number(fields[12]), startTicks: Number(fields[19]) }
}

export function cpuPercent(current, previous, elapsedMs, hz) {
  if (!previous || current.startTicks !== previous.startTicks || elapsedMs <= 0) return null
  return Math.max(0, Math.round((current.cpuTicks - previous.cpuTicks) / hz / (elapsedMs / 1000) * 100))
}

export function buildProcessGroups(processes, roots) {
  const byPid = new Map(processes.map(p => [p.pid, p]))
  const owners = new Map(roots.filter(r => byPid.has(r.pid)).map(r => [r.pid, r]))
  const groups = new Map([...owners.values()].map(r => [r.id, { ...r, processes: [], rssBytes: 0, pssBytes: 0, cpuPercent: 0 }]))
  for (const p of processes) {
    let cursor = p
    const seen = new Set()
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid)
      const owner = owners.get(cursor.pid)
      if (owner) {
        const g = groups.get(owner.id)
        g.processes.push(p)
        g.rssBytes += p.rssBytes
        g.pssBytes = g.pssBytes === null || p.pssBytes === null ? null : g.pssBytes + p.pssBytes
        g.cpuPercent = g.cpuPercent === null || p.cpuPercent == null ? null : g.cpuPercent + p.cpuPercent
        break
      }
      cursor = byPid.get(cursor.ppid)
    }
  }
  return [...groups.values()].map(g => ({ ...g, processes: g.processes.sort((a,b) => a.pid - b.pid) })).sort((a,b) => b.rssBytes - a.rssBytes)
}

const read = p => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const json = p => { try { return JSON.parse(read(p)) } catch { return null } }
const kb = (text, key) => { const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text); return m ? Number(m[1]) * 1024 : null }
const serviceNames = {
  'claude-code-bot.service': 'Coding room host',
  'watchlist.service': 'Watchlist',
  'discord-room.service': 'Discord',
  'calendar-lab-bot.service': 'Calendar Lab',
  'invoice-bot.service': 'Invoices',
  'lore2-prod.service': 'Lore',
  'claude-remote-control.service': 'Claude remote session',
}

function configuredRooms(home, profile) {
  const base = profile === 'default' ? home : path.join(home, 'profiles', profile)
  return [...read(path.join(base, 'rooms.yaml')).matchAll(/^  ["']?(![^\s"']+)["']?:\s*$/gm)].map(m => m[1])
}

export function createProcessSampler({ procRoot = '/proc', home = path.join(os.homedir(), '.hermes'), hz } = {}) {
  hz ??= Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
  let previous = new Map()
  let previousAt = 0
  const pageRooms = {
    'watchlist.service': json(path.join(os.homedir(), '.config/watchlist/room.json'))?.roomId,
    'discord-room.service': json(path.join(os.homedir(), '.config/discord-room/room.json'))?.roomId,
  }
  return ({ roots: explicitRoots = [], roomName = () => null } = {}) => {
    const now = Date.now()
    const processes = []
    const candidates = []
    const uptime = Number(read(path.join(procRoot, 'uptime')).split(' ')[0])
    for (const dir of fs.readdirSync(procRoot).filter(p => /^\d+$/.test(p))) {
      const base = path.join(procRoot, dir)
      try {
        if (fs.statSync(base).uid !== process.getuid()) continue
        const status = read(path.join(base, 'status'))
        const stat = parseProcStat(read(path.join(base, 'stat')))
        if (!Number.isFinite(stat.startTicks)) continue // vanished during sample
        const pid = Number(dir)
        const p = { pid, ...stat, name: path.basename(read(path.join(base, 'comm')).trim()).slice(0, 60),
          rssBytes: kb(status, 'VmRSS') ?? 0, peakRssBytes: kb(status, 'VmHWM') ?? 0,
          pssBytes: null, cpuPercent: null, ageSeconds: Math.max(0, Math.floor(uptime - stat.startTicks / hz)) }
        p.cpuPercent = cpuPercent(p, previous.get(pid), now - previousAt, hz)
        processes.push(p)
        // Used locally to classify only; never returned in the Matrix payload.
        const unit = serviceFromCgroup(read(path.join(base, 'cgroup')))
        const argv = read(path.join(base, 'cmdline')).split('\0')
        const profileArg = argv.findIndex(v => v === '-p' || v === '--profile')
        const profile = profileArg >= 0 ? argv[profileArg + 1] : 'default'
        const isHermes = p.name === 'hermes' || argv.some(v => /\/hermes$/.test(v))
        if (unit && (serviceNames[unit] || unit.startsWith('hermes-gateway'))) {
          const gateway = unit.startsWith('hermes-gateway')
          const gatewayProfile = unit === 'hermes-gateway.service' ? 'default' : unit.slice('hermes-gateway-'.length, -'.service'.length)
          candidates.push({ pid, ppid: p.ppid, unit, id: unit, label: gateway ? `Hermes · ${gatewayProfile}` : serviceNames[unit],
            profile: gateway ? gatewayProfile : null,
            roomIds: gateway ? configuredRooms(home, gatewayProfile) : [pageRooms[unit]].filter(Boolean),
            shared: gateway || unit === 'claude-code-bot.service', mapping: gateway ? 'shared-profile' : pageRooms[unit] ? 'dedicated-room' : 'service' })
        } else if (isHermes && /^[a-zA-Z0-9_-]+$/.test(profile)) {
          candidates.push({ pid, id: `hermes-${pid}-${stat.startTicks}`, label: `Hermes · ${profile}`, profile, roomIds: configuredRooms(home, profile), shared: true, mapping: 'profile' })
        }
      } catch { /* process exited or inaccessible */ }
    }
    const candidatePids = new Set(candidates.map(c => c.pid))
    // Only the top process in each service is a root; explicit room roots below win.
    const byPid = new Map(processes.map(p => [p.pid, p]))
    const roots = candidates.filter(c => {
      let parent = byPid.get(c.ppid)
      const seen = new Set()
      while (parent && !seen.has(parent.pid)) {
        seen.add(parent.pid)
        if (candidatePids.has(parent.pid)) return false
        parent = byPid.get(parent.ppid)
      }
      return true
    })
    roots.push(...explicitRoots)
    // Read PSS only for agent trees, not every desktop process.
    const owned = new Set(buildProcessGroups(processes, roots).flatMap(g => g.processes.map(p => p.pid)))
    for (const p of processes) if (owned.has(p.pid)) p.pssBytes = kb(read(path.join(procRoot, String(p.pid), 'smaps_rollup')), 'Pss')
    const groups = buildProcessGroups(processes, roots).map(g => ({ ...g,
      rooms: (g.roomIds ?? []).map(id => ({ id, name: roomName(id) ?? id })),
      processes: g.processes.map(({ cpuTicks, startTicks, ...p }) => p),
    }))
    previous = new Map(processes.map(p => [p.pid, p]))
    previousAt = now
    const memory = read(path.join(procRoot, 'meminfo'))
    return { version: 1, fetched_at: now, intervalMs: 30000, host: { name: os.hostname(), cpuCores: os.cpus().length,
      totalBytes: kb(memory, 'MemTotal'), availableBytes: kb(memory, 'MemAvailable'),
      swapTotalBytes: kb(memory, 'SwapTotal'), swapFreeBytes: kb(memory, 'SwapFree') }, groups }
  }
}
