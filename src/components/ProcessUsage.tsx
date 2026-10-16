import { Link } from 'react-router-dom'
import type * as sdk from 'matrix-js-sdk'
import { useProcessUsage, type ProcessGroup, type ProcessReading, type ProcessUsage as ProcessSnapshot } from '../hooks/useProcessUsage'
import { useMinuteClock } from '../hooks/usePlanUsage'

function memory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GiB` : `${Math.round(bytes / 1048576)} MiB`
}
function cpu(value: number | null): string { return value == null ? 'Warming up' : `${value}%` }
function depth(p: ProcessReading, rows: ProcessReading[]): number {
  const parents = new Map(rows.map(r => [r.pid, r.ppid]))
  const seen = new Set([p.pid])
  let pid = p.ppid
  let n = 0
  while (parents.has(pid) && !seen.has(pid)) { seen.add(pid); n++; pid = parents.get(pid)! }
  return Math.min(n, 5)
}
function treeOrder(rows: ProcessReading[]): ProcessReading[] {
  const ids = new Set(rows.map(p => p.pid))
  const out: ProcessReading[] = []
  const seen = new Set<number>()
  const visit = (p: ProcessReading) => {
    if (seen.has(p.pid)) return
    seen.add(p.pid); out.push(p)
    rows.filter(r => r.ppid === p.pid).forEach(visit)
  }
  rows.filter(p => !ids.has(p.ppid)).forEach(visit)
  rows.forEach(visit)
  return out
}
function Group({ group }: { group: ProcessGroup }) {
  return <section className="settings-section usage-card process-group">
    <div className="usage-card-head"><h3 className="settings-section-title">{group.label}</h3><strong>{memory(group.pssBytes ?? group.rssBytes)}</strong></div>
    <p className="usage-card-hint">{group.shared ? 'Shared process — not a per-room allocation' : group.rooms.length ? 'Dedicated room process' : 'Service process'} · {group.processes.length} processes</p>
    {group.rooms.length > 0 && <div className="process-rooms">{group.rooms.map(r => <Link key={r.id} to={`/rooms/${encodeURIComponent(r.id)}`}>{r.name}</Link>)}</div>}
    <div className="usage-row"><span>CPU · 100% = one core</span><span>{cpu(group.cpuPercent)}</span></div>
    <div className="usage-row"><span>RAM · PSS / RSS</span><span>{memory(group.pssBytes)} / {memory(group.rssBytes)}</span></div>
    <details className="process-details"><summary>Processes & children</summary>
      {treeOrder(group.processes).map(p => <div key={p.pid} className="process-entry" style={{ paddingLeft: `${depth(p, group.processes) * 12}px` }}>
        <div className="usage-row"><span><code>{p.pid}</code> {p.name}</span><strong>{memory(p.pssBytes ?? p.rssBytes)}</strong></div>
        <p className="usage-card-hint">CPU {cpu(p.cpuPercent)} · RSS {memory(p.rssBytes)} · peak RSS {memory(p.peakRssBytes)} · alive {Math.floor(p.ageSeconds / 60)}m</p>
      </div>)}
    </details>
  </section>
}
export default function ProcessUsage({ client }: { client: sdk.MatrixClient | null }) {
  const reading = useProcessUsage(client)
  const now = useMinuteClock()
  return <ProcessUsageReading reading={reading} now={now} />
}
export function ProcessUsageReading({ reading, now }: { reading: ProcessSnapshot | null; now: number }) {
  if (!reading) return <section className="settings-section"><h2 className="settings-section-title">Host & agents</h2><p className="settings-empty">Waiting for the host’s first process reading…</p></section>
  const { host, groups } = reading
  const age = Math.max(0, Math.floor((now - reading.fetched_at) / 60000))
  return <>
    <h2 className="usage-provider">Host & agents</h2>
    <section className="settings-section usage-card">
      <h3 className="settings-section-title">{host.name}</h3>
      <div className="usage-row"><span>RAM available / total</span><strong>{memory(host.availableBytes)} / {memory(host.totalBytes)}</strong></div>
      <div className="usage-row"><span>Swap used / total</span><span>{memory(host.swapTotalBytes - host.swapFreeBytes)} / {memory(host.swapTotalBytes)}</span></div>
      <div className="usage-row"><span>CPU cores</span><span>{host.cpuCores}</span></div>
    </section>
    <p className={now - reading.fetched_at > 120000 ? 'usage-stale' : 'usage-footnote'}>{age ? `Sampled ${age} min ago` : 'Sampled just now'} · refreshes every 30 seconds.{now - reading.fetched_at > 120000 ? ' Readings are stale.' : ''}</p>
    {groups.map(g => <Group key={g.id} group={g} />)}
    <p className="usage-footnote">PSS apportions shared memory; RSS includes shared pages in each process. Each process belongs to one group only. Peak RSS is per process, not a simultaneous group peak. CPU is measured between samples; process lifetime is not agent activity.</p>
  </>
}
