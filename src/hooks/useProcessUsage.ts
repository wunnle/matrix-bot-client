import type * as sdk from 'matrix-js-sdk'
import { usePublishedUsage } from './usePlanUsage'

export interface ProcessReading {
  pid: number
  ppid: number
  name: string
  rssBytes: number
  pssBytes: number | null
  peakRssBytes: number
  cpuPercent: number | null
  ageSeconds: number
}
export interface ProcessGroup {
  id: string
  pid: number
  label: string
  profile?: string | null
  shared: boolean
  rooms: { id: string; name: string }[]
  rssBytes: number
  pssBytes: number | null
  cpuPercent: number | null
  processes: ProcessReading[]
}
export interface ProcessUsage {
  version: number
  fetched_at: number
  intervalMs: number
  host: { name: string; cpuCores: number; totalBytes: number; availableBytes: number; swapTotalBytes: number; swapFreeBytes: number }
  groups: ProcessGroup[]
}
function parse(content: unknown): ProcessUsage | null {
  if (!content || typeof content !== 'object') return null
  const raw = content as ProcessUsage
  if (raw.version !== 1 || !Number.isFinite(raw.fetched_at) || !raw.host || !Number.isFinite(raw.host.totalBytes) || !Array.isArray(raw.groups)) return null
  if (!raw.groups.every(g => typeof g.id === 'string' && typeof g.label === 'string' && Array.isArray(g.rooms) && Array.isArray(g.processes) &&
    g.rooms.every(r => typeof r.id === 'string' && typeof r.name === 'string') &&
    g.processes.every(p => Number.isFinite(p.pid) && Number.isFinite(p.ppid) && typeof p.name === 'string' && Number.isFinite(p.rssBytes)))) return null
  return raw
}
export function useProcessUsage(client: sdk.MatrixClient | null) {
  return usePublishedUsage(client, 'processes', parse)
}
