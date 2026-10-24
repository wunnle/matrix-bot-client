import { useEffect, useMemo, useState } from 'react'
import { apiUrl } from './apiUrl'
import { intentCredential } from './matrix'
import type { RoomMedia } from './roomMedia'

/**
 * Live Linear details for the sidebar's issue and project rows, from
 * /api/linear (which holds the key). Kept here for two minutes, so reopening
 * the panel asks for nothing; one request covers every key not already known.
 * Anything that goes wrong leaves the rows as they are without it.
 */

export interface LinearState { name: string; color?: string; type: string }
export interface LinearIssue {
  title: string
  state: LinearState
  priority?: number
  priorityLabel?: string
  assignee?: string
  /** The project's slugId. */
  project?: string
  updatedAt: string
}
export interface LinearProject {
  name: string
  url: string
  status: LinearState
  /** Percent, 0–100. */
  progress?: number
  /** yyyy-mm-dd */
  targetDate?: string
  lead?: string
}
export interface LinearInfo {
  issues: Record<string, LinearIssue>
  projects: Record<string, LinearProject>
}

const TTL_MS = 2 * 60 * 1000
const MAX = 50

// null: Linear has no such thing. Kept like a hit, so it isn't asked again.
const cache = new Map<string, { value: LinearIssue | LinearProject | null; expires: number }>()
// After a failure (no key configured, Linear down) nothing is asked for a while.
let quietUntil = 0

function fresh(key: string) {
  const hit = cache.get(key)
  return hit && hit.expires > Date.now() ? hit : undefined
}

function fromCache(issueKeys: string[], projectSlugs: string[]): LinearInfo {
  const info: LinearInfo = { issues: {}, projects: {} }
  for (const k of issueKeys) {
    const v = cache.get(`issue:${k}`)?.value as LinearIssue | null | undefined
    if (v) info.issues[k] = v
  }
  // Projects asked for, and the projects of the issues found.
  const slugs = new Set([...projectSlugs, ...Object.values(info.issues).flatMap((i) => (i.project ? [i.project] : []))])
  for (const s of slugs) {
    const v = cache.get(`project:${s}`)?.value as LinearProject | null | undefined
    if (v) info.projects[s] = v
  }
  return info
}

async function load(issueKeys: string[], projectSlugs: string[]): Promise<void> {
  const issues = issueKeys.filter((k) => !fresh(`issue:${k}`)).slice(0, MAX)
  const projects = projectSlugs.filter((s) => !fresh(`project:${s}`)).slice(0, MAX)
  if ((!issues.length && !projects.length) || Date.now() < quietUntil) return
  const secret = intentCredential()
  if (!secret) return
  try {
    const r = await fetch(apiUrl('/api/linear'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intent-secret': secret },
      body: JSON.stringify({ issues, projects }),
    })
    if (!r.ok) throw new Error(`linear ${r.status}`)
    const body = (await r.json()) as { issues: Record<string, LinearIssue | null>; projects: Record<string, LinearProject | null> }
    const expires = Date.now() + TTL_MS
    for (const [k, v] of Object.entries(body.issues ?? {})) cache.set(`issue:${k}`, { value: v, expires })
    for (const [s, v] of Object.entries(body.projects ?? {})) cache.set(`project:${s}`, { value: v, expires })
  } catch {
    quietUntil = Date.now() + TTL_MS
  }
}

/**
 * The Linear details for a room's issue keys and project links. `sample`
 * stands in for the API (the design page); with it nothing is fetched.
 */
export function useLinearInfo(media: RoomMedia, sample?: LinearInfo): LinearInfo {
  const issueKeys = useMemo(() => media.refs.filter((r) => r.kind === 'linear').map((r) => r.label), [media.refs])
  const projectSlugs = useMemo(() => media.projects.map((p) => p.slug), [media.projects])
  const want = `${issueKeys.join(',')}|${projectSlugs.join(',')}`
  // Bumped when a load lands, to read the cache again.
  const [loaded, setLoaded] = useState(0)

  useEffect(() => {
    if (sample) return
    let live = true
    load(issueKeys, projectSlugs).then(() => { if (live) setLoaded((n) => n + 1) })
    return () => { live = false }
    // `want` stands for both lists; a re-render with the same keys asks nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, sample])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => sample ?? fromCache(issueKeys, projectSlugs), [issueKeys, projectSlugs, sample, loaded])
}
