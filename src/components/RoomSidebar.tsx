import { useMemo, useRef, useState, type ReactNode } from 'react'
import type * as React from 'react'
import { isEmptyRoomMedia, type RoomLink, type RoomMedia, type RoomProject, type RoomRef } from '../lib/roomMedia'
import { useLinearInfo, type LinearInfo, type LinearState } from '../lib/linearInfo'
import { mapsUrl, formatCoords } from '../lib/location'
import type { PlanStep } from '../lib/roomStatus'
import ArtifactPreview from './ArtifactPreview'
import BrowserPanel from './BrowserPanel'

// Brand marks (Simple Icons), drawn in the text colour.
const LINEAR_PATH = 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z'
const GITHUB_PATH = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'

const linearUrl = (key: string) => `https://linear.app/wunnle/issue/${key}`

const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
// A date-only yyyy-mm-dd is that day wherever you are, not UTC midnight.
const targetDay = (date: string) => day(new Date(`${date}T12:00:00`).getTime())

// Short, as Linear writes it: a phone row has room for little else.
function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(mins)) return ''
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`
  if (mins < 30 * 24 * 60) return `${Math.round(mins / (24 * 60))}d`
  return day(Date.parse(iso))
}

// Linear's own state colours, when they are colours.
const stateColor = (s?: LinearState) => (s?.color && /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : 'var(--text-muted)')

/** The Room tab's alert: what the agent needs from you, when it needs
 *  something. What it is doing shows in the chat already. */
function OverviewStatus({ overview, onJump }: { overview: RoomOverview; onJump: (eventId: string) => void }) {
  const { approval, blocked } = overview
  if (!approval && !blocked) return null
  const [kind, icon, title, sub] = approval
    ? ['approval', 'lock', 'Waiting for your approval',
        [approval.tool, approval.agent && `from ${approval.agent}`, approval.target].filter(Boolean).join(' · ')]
    : ['blocked', 'block', 'Stuck on its usage limit', blocked]
  return (
    <section className={`room-overview-status room-overview-status--${kind}`} aria-live="polite">
      <span className="material-symbols-outlined room-overview-status-icon" aria-hidden="true">{icon}</span>
      <div className="room-overview-status-text">
        <span className="room-overview-status-title">{title}</span>
        {sub && <span className="room-overview-status-sub">{sub}</span>}
      </div>
      {approval && (
        <button type="button" className="room-overview-status-action" onClick={() => onJump(approval.eventId)}>Show</button>
      )}
    </section>
  )
}

/** A project's progress as Linear draws it: a ring in its status colour. */
function ProgressRing({ percent, color }: { percent: number; color: string }) {
  const r = 6.5
  const c = 2 * Math.PI * r
  return (
    <svg className="room-sidebar-ring" viewBox="0 0 16 16" role="img" aria-label={`Linear project, ${percent}% done`}>
      <circle cx="8" cy="8" r={r} className="room-sidebar-ring-track" />
      <circle
        cx="8" cy="8" r={r} stroke={color}
        strokeDasharray={`${(c * Math.min(100, Math.max(0, percent))) / 100} ${c}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/**
 * A room's side panel: what was shared in it (issues and PRs, Obsidian notes,
 * links, images, files, places), collected from the loaded
 * messages. A column beside the chat on wide screens, a full sheet on the
 * phone. A row opens its thing; "In chat" under it finds the message it came from.
 * When agents published pages to claude.ai, an Artifacts tab shows them, one
 * at a time, from the copy the bot keeps (claude.ai itself can't be framed).
 * The Browser tab opens any page beside the chat (BrowserPanel).
 */
export type SidebarTab = 'room' | 'artifacts' | 'browser' | 'shared'

/**
 * The Room tab: what the agent is doing now and what it is working on, from
 * room state (useRoomStatus, useAgentBlocked) and the run in the timeline.
 */
export interface RoomOverview {
  /** The approval card waiting on you. */
  approval: { tool: string; agent?: string; target?: string; eventId: string } | null
  /** Why the agent is stuck (its usage limit), when it is. */
  blocked: string | null
  /** The agent's plan (construct-plan), when it set one. */
  plan: PlanStep[] | null
  /** The Linear issues the room is about. */
  issues: string[]
  /** 'agent' when it said so (construct-issue), 'name' when read from the room name. */
  issuesFrom: 'agent' | 'name' | null
}

// The panel's width on wide screens, dragged by its left edge and remembered.
// A page and a list want different widths, so each keeps its own; unset, the
// stylesheet's default applies.
type WidthMode = 'list' | 'page'
const WIDTH_KEY: Record<WidthMode, string> = { list: 'room-sidebar-width', page: 'room-sidebar-page-width' }
const MIN_WIDTH = 260
// The chat keeps at least this much of the row.
const CHAT_MIN = 360

function storedWidth(mode: WidthMode): number | undefined {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY[mode]))
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : undefined
  } catch { return undefined }
}

function clampWidth(w: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - CHAT_MIN)))
}

export default function RoomSidebar({ media, mediaUrls, hasMore, loadingMore, onLoadMore, onJump, onOpenImage, onClose, motion, onMotionEnd, tab, onTab, openArtifact, onOpenArtifact, browserUrl, onBrowserUrl, roomId, linearSample, overview }: {
  media: RoomMedia
  /** The Room tab's contents; without it there is no Room tab. */
  overview?: RoomOverview
  /** Resolved image/file URLs by event id. */
  mediaUrls: Record<string, string>
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onJump: (eventId: string) => void
  onOpenImage: (url: string, alt: string) => void
  onClose: () => void
  /** Sliding in, or out on its way to being unmounted. */
  motion?: 'in' | 'out' | null
  onMotionEnd?: () => void
  tab: SidebarTab
  onTab: (tab: SidebarTab) => void
  /** The artifact shown, by id; null for the list, undefined for the newest. */
  openArtifact: string | null | undefined
  onOpenArtifact: (id: string | null) => void
  /** The Browser tab's page; null when none is open. */
  browserUrl: string | null
  onBrowserUrl: (url: string | null) => void
  /** Linear details to show instead of fetching them (the design page). */
  linearSample?: LinearInfo
  /** Keeps the Browser tab's history for this room on this device. */
  roomId?: string
}) {
  // No artifacts, no Artifacts tab.
  const hasArtifacts = media.artifacts.length > 0
  const current: SidebarTab = tab === 'browser' ? 'browser'
    : hasArtifacts && tab === 'artifacts' ? 'artifacts'
    : overview && (tab === 'room' || (tab === 'artifacts' && !hasArtifacts)) ? 'room'
    : 'shared'
  const shown = current === 'artifacts' && openArtifact !== null
    ? media.artifacts.find((a) => a.id === openArtifact) ?? media.artifacts[0]
    : null

  const mode: WidthMode = shown || current === 'browser' ? 'page' : 'list'
  const [widths, setWidths] = useState<Partial<Record<WidthMode, number>>>(() => ({ list: storedWidth('list'), page: storedWidth('page') }))
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ x: number; width: number } | null>(null)
  const setWidth = (w: number | undefined, persist: boolean) => {
    setWidths((prev) => ({ ...prev, [mode]: w }))
    if (!persist) return
    try {
      if (w === undefined) localStorage.removeItem(WIDTH_KEY[mode])
      else localStorage.setItem(WIDTH_KEY[mode], String(w))
    } catch { /* private mode: the width just isn't remembered */ }
  }
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const aside = asideRef.current
    if (!aside || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, width: aside.getBoundingClientRect().width }
    setResizing(true)
  }
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    // Dragging left widens: the panel's left edge is the one that moves.
    if (drag) setWidth(clampWidth(drag.width + drag.x - e.clientX), false)
  }
  const onResizeUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setResizing(false)
    setWidth(widths[mode], true)
  }
  const onResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    const current = asideRef.current?.getBoundingClientRect().width ?? 320
    if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(clampWidth(current + step), true) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(clampWidth(current - step), true) }
  }

  // On the phone the panel is a sheet: a swipe to the right puts it away.
  // Not from inside a page, which keeps its own touches.
  const swipeRef = useRef<{ x: number; y: number } | null>(null)
  const onSwipeStart = (e: React.TouchEvent) => {
    swipeRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }
  const onSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeRef.current
    swipeRef.current = null
    if (!start || window.matchMedia('(min-width: 641px)').matches) return
    const dx = e.changedTouches[0].clientX - start.x
    const dy = Math.abs(e.changedTouches[0].clientY - start.y)
    if (dx > 80 && dy < 60) onClose()
  }
  // Links by site, sites in order of their newest link.
  const linkGroups = useMemo(() => {
    const groups = new Map<string, RoomLink[]>()
    for (const l of media.links) groups.set(l.host, [...(groups.get(l.host) ?? []), l])
    return [...groups.entries()]
  }, [media.links])

  // The Room tab's issues are looked up with the rest, in the same request.
  const overviewIssues = overview?.issues
  const lookup = useMemo(() => {
    const known = new Set(media.refs.map((r) => r.label))
    const extra: RoomRef[] = (overviewIssues ?? []).filter((k) => !known.has(k)).map((k) => ({
      kind: 'linear', label: k, url: linearUrl(k), eventId: '', timestamp: 0,
    }))
    return extra.length ? { ...media, refs: [...media.refs, ...extra] } : media
  }, [media, overviewIssues])
  const linear = useLinearInfo(lookup, linearSample)
  // Issues under their projects, as agents hang under their parents in the
  // room list: each project (linked, or known from an issue's details) with its
  // issues, then the issues without one and the PRs, newest first throughout.
  const refTree = useMemo(() => {
    const groups = new Map<string, { project: RoomProject; refs: RoomRef[]; at: number }>(
      media.projects.map((p) => [p.slug, { project: p, refs: [], at: p.timestamp }]),
    )
    const loose: { refs: RoomRef[]; at: number }[] = []
    for (const r of media.refs) {
      const slug = r.kind === 'linear' ? linear.issues[r.label]?.project : undefined
      const info = slug ? linear.projects[slug] : undefined
      if (!slug || !info) { loose.push({ refs: [r], at: r.timestamp }); continue }
      const group = groups.get(slug)
        ?? { project: { slug, name: info.name, url: info.url, eventId: r.eventId, timestamp: r.timestamp }, refs: [], at: 0 }
      group.refs.push(r)
      group.at = Math.max(group.at, r.timestamp)
      groups.set(slug, group)
    }
    return [...groups.values(), ...loose].sort((a, b) => b.at - a.at) as { project?: RoomProject; refs: RoomRef[]; at: number }[]
  }, [media.projects, media.refs, linear])

  // The link stretches over the whole row (see .room-sidebar-link::after);
  // "In chat" sits above it, so it is the one spot that does something else.
  const row = (key: string, eventId: string, { href, onOpen, title, sub, icon, download, hover, className }: {
    href?: string
    /** Opens it here in the panel instead of following a link. */
    onOpen?: () => void
    title: ReactNode
    sub?: ReactNode
    icon?: ReactNode
    download?: string
    hover?: string
    className?: string
  }) => (
    <div key={key} className={`room-sidebar-row${className ? ` ${className}` : ''}`}>
      {icon}
      <div className="room-sidebar-row-text">
        {onOpen ? (
          <button type="button" className="room-sidebar-link" onClick={onOpen} title={hover}>{title}</button>
        ) : (
          <a
            className="room-sidebar-link"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            download={download}
            aria-disabled={!href}
            title={hover}
          >
            {title}
          </a>
        )}
        <div className="room-sidebar-meta">
          {sub && <span className="room-sidebar-meta-text">{sub}</span>}
          <button type="button" className="room-sidebar-jump" onClick={() => onJump(eventId)}>In chat</button>
        </div>
      </div>
    </div>
  )
  const projectRow = (p: RoomProject, hasIssues: boolean) => {
    const info = linear.projects[p.slug]
    return row(`project:${p.slug}`, p.eventId, {
      href: info?.url ?? p.url,
      title: info?.name ?? p.name,
      sub: info
        ? [info.status.name, info.progress !== undefined && `${info.progress}%`, info.targetDate ? `Target ${targetDay(info.targetDate)}` : info.lead]
            .filter(Boolean).join(' · ')
        : day(p.timestamp),
      icon: <ProgressRing percent={info?.progress ?? 0} color={stateColor(info?.status)} />,
      className: hasIssues ? 'room-sidebar-row--parent' : undefined,
    })
  }
  const refRow = (r: RoomRef, treeClass?: string) => {
    const issue = r.kind === 'linear' ? linear.issues[r.label] : undefined
    const icon = (
      <svg className="room-sidebar-ref-icon" viewBox="0 0 24 24" role="img" aria-label={r.kind === 'linear' ? 'Linear' : 'GitHub'}>
        <path d={r.kind === 'linear' ? LINEAR_PATH : GITHUB_PATH} />
      </svg>
    )
    if (!issue) {
      return row(r.label, r.eventId, {
        href: r.url,
        title: r.label,
        sub: r.title && r.title !== r.label ? r.title : day(r.timestamp),
        icon,
        className: treeClass,
      })
    }
    const closed = issue.state.type === 'completed' || issue.state.type === 'canceled'
    return row(r.label, r.eventId, {
      href: r.url,
      title: <><span className="room-sidebar-key">{r.label}</span>{issue.title}</>,
      hover: `${r.label} ${issue.title}`,
      sub: (
        <>
          <span className="room-sidebar-dot" style={{ background: stateColor(issue.state) }} />
          {[issue.state.name, issue.priorityLabel, issue.assignee, ago(issue.updatedAt)].filter(Boolean).join(' · ')}
        </>
      ),
      icon,
      className: [treeClass, closed && 'room-sidebar-row--closed'].filter(Boolean).join(' ') || undefined,
    })
  }

  // Artifacts have their own tab; the Shared one is empty without the rest.
  const empty = isEmptyRoomMedia({ ...media, artifacts: [] })

  // For the Room tab: the newest PRs, and a one-line count of the rest.
  const prs = media.refs.filter((r) => r.kind === 'github').slice(0, 3)
  const sharedCounts = ([
    [media.refs.length + media.projects.length, 'issue & PR', 'issues & PRs'],
    [media.notes.length, 'note', 'notes'],
    [media.links.length, 'link', 'links'],
    [media.images.length, 'image', 'images'],
    [media.files.length, 'file', 'files'],
    [media.places.length, 'place', 'places'],
  ] as const).filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)

  return (
    <aside
      ref={asideRef}
      className={`room-sidebar${mode === 'page' ? ' room-sidebar--wide' : ''}${resizing ? ' room-sidebar--resizing' : ''}${motion ? ` room-sidebar--${motion}` : ''}`}
      style={widths[mode] ? ({ '--room-sidebar-width': `${widths[mode]}px` } as React.CSSProperties) : undefined}
      aria-label="Shared in this room"
      aria-hidden={motion === 'out' || undefined}
      onTouchStart={onSwipeStart}
      onTouchEnd={onSwipeEnd}
      // Its own slide only, not one bubbling up from inside.
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) onMotionEnd?.() }}
    >
      <div
        className="room-sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={() => setWidth(undefined, true)}
        onKeyDown={onResizeKey}
      />
      <div className="room-sidebar-header">
        <div className="room-sidebar-tabs" role="tablist" aria-label="Side panel">
          {overview && (
            <button
              type="button" role="tab" aria-selected={current === 'room'}
              className={`room-sidebar-tab${current === 'room' ? ' room-sidebar-tab--on' : ''}`}
              onClick={() => onTab('room')}
            >
              Room
            </button>
          )}
          {hasArtifacts && (
            <button
              type="button" role="tab" aria-selected={current === 'artifacts'}
              className={`room-sidebar-tab${current === 'artifacts' ? ' room-sidebar-tab--on' : ''}`}
              onClick={() => onTab('artifacts')}
            >
              Artifacts <span>{media.artifacts.length}</span>
            </button>
          )}
          <button
            type="button" role="tab" aria-selected={current === 'browser'}
            className={`room-sidebar-tab${current === 'browser' ? ' room-sidebar-tab--on' : ''}`}
            onClick={() => onTab('browser')}
          >
            Browser
          </button>
          <button
            type="button" role="tab" aria-selected={current === 'shared'}
            className={`room-sidebar-tab${current === 'shared' ? ' room-sidebar-tab--on' : ''}`}
            onClick={() => onTab('shared')}
          >
            Shared
          </button>
        </div>
        <button type="button" className="room-sidebar-close" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      {current === 'room' && overview ? (
        <div className="room-sidebar-body room-overview">
          <OverviewStatus overview={overview} onJump={onJump} />

          {overview.plan && (
            <section className="room-sidebar-section">
              <h3>Plan</h3>
              <ol className="room-overview-plan">
                {overview.plan.map((step, i) => (
                  <li key={i} className={`room-overview-step room-overview-step--${step.state}`}>
                    <span className="material-symbols-outlined room-overview-step-icon" aria-hidden="true">
                      {step.state === 'done' ? 'check_circle' : step.state === 'now' ? 'radio_button_partial' : 'radio_button_unchecked'}
                    </span>
                    <span className="room-overview-step-text">
                      {step.text}
                      {step.state !== 'todo' && <span className="room-overview-step-sr">{step.state === 'done' ? ' (done)' : ' (in progress)'}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {overview.issues.length > 0 && (
            <section className="room-sidebar-section">
              <h3>Working on</h3>
              {overview.issues.map((key) => {
                const issue = linear.issues[key]
                const project = issue?.project ? linear.projects[issue.project] : undefined
                return (
                  <a key={key} className="room-overview-issue" href={linearUrl(key)} target="_blank" rel="noopener noreferrer">
                    <span className="room-overview-issue-head">
                      <svg className="room-sidebar-ref-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={LINEAR_PATH} /></svg>
                      <span className="room-sidebar-key">{key}</span>
                      {issue && (
                        <span className="room-overview-issue-state">
                          <span className="room-sidebar-dot" style={{ background: stateColor(issue.state) }} />
                          {issue.state.name}
                        </span>
                      )}
                    </span>
                    <span className="room-overview-issue-title">{issue?.title ?? 'Loading from Linear…'}</span>
                    {issue && (
                      <span className="room-overview-issue-meta">
                        {[project?.name, issue.priorityLabel, issue.assignee, `updated ${ago(issue.updatedAt)}`].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </a>
                )
              })}
              {overview.issuesFrom === 'name' && <p className="room-overview-note">From the room name</p>}
            </section>
          )}

          {(media.artifacts.length > 0 || browserUrl || prs.length > 0) && (
            <section className="room-sidebar-section">
              <h3>Latest</h3>
              {media.artifacts[0] && row(`artifact:${media.artifacts[0].id}`, media.artifacts[0].eventId, {
                onOpen: () => { onOpenArtifact(media.artifacts[0].id); onTab('artifacts') },
                title: media.artifacts[0].title ?? 'Artifact',
                sub: `Artifact · ${day(media.artifacts[0].timestamp)}`,
                icon: <span className="material-symbols-outlined room-sidebar-note-icon" aria-hidden="true">article</span>,
              })}
              {browserUrl && (
                <div className="room-sidebar-row">
                  <span className="material-symbols-outlined room-sidebar-note-icon" aria-hidden="true">public</span>
                  <div className="room-sidebar-row-text">
                    <button type="button" className="room-sidebar-link" onClick={() => onTab('browser')} title={browserUrl}>
                      {browserUrl.replace(/^https?:\/\/(www\.)?/, '')}
                    </button>
                    <div className="room-sidebar-meta"><span>Open in the Browser tab</span></div>
                  </div>
                </div>
              )}
              {prs.map((r) => refRow(r))}
            </section>
          )}

          {sharedCounts.length > 0 && (
            <button type="button" className="room-overview-shared" onClick={() => onTab('shared')}>
              <span>{sharedCounts.join(' · ')}</span>
              <span className="material-icons" aria-hidden="true">chevron_right</span>
            </button>
          )}
        </div>
      ) : current === 'browser' ? (
        <BrowserPanel url={browserUrl} onUrl={onBrowserUrl} roomId={roomId} />
      ) : shown ? (
        <div className="artifact-view">
          <div className="artifact-view-bar">
            <button type="button" className="artifact-view-back" aria-label="All artifacts" onClick={() => onOpenArtifact(null)}>
              <span className="material-icons">chevron_left</span>
            </button>
            <div className="artifact-view-heading">
              <span className="artifact-view-title">{shown.title ?? 'Artifact'}</span>
              <span className="artifact-view-meta">
                {shown.version && shown.version > 1 ? `Version ${shown.version} · ` : ''}{day(shown.timestamp)}
              </span>
            </div>
            <a className="artifact-view-open" href={shown.url} target="_blank" rel="noopener noreferrer">
              claude.ai<span className="material-icons" aria-hidden="true">open_in_new</span>
            </a>
          </div>
          {shown.snapshot
            ? <ArtifactPreview key={shown.snapshot.mxc} snapshot={shown.snapshot} title={shown.title ?? 'Artifact'} />
            : <p className="artifact-preview-note">There's no in-app copy of this page: it was published with supporting files, its upload failed, or it was posted as a plain link. Open it on claude.ai.</p>}
        </div>
      ) : current === 'artifacts' ? (
        <div className="room-sidebar-body">
          <section className="room-sidebar-section">
            {media.artifacts.map((a) => row(a.id, a.eventId, {
              onOpen: () => onOpenArtifact(a.id),
              title: a.title ?? a.url.replace(/^https:\/\//, ''),
              sub: a.description ?? day(a.timestamp),
              hover: a.url,
              icon: <span className="material-symbols-outlined room-sidebar-note-icon" aria-hidden="true">article</span>,
            }))}
          </section>
        </div>
      ) : (
      <div className="room-sidebar-body">
        {empty && <p className="room-sidebar-empty">Nothing shared in the loaded messages yet.</p>}

        {refTree.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Issues &amp; PRs <span>{media.refs.length + refTree.filter((e) => e.project).length}</span></h3>
            {refTree.map((e) => e.project ? (
              <div key={`project:${e.project.slug}`} className="room-sidebar-tree">
                {projectRow(e.project, e.refs.length > 0)}
                {e.refs.map((r, i) => refRow(r, i === e.refs.length - 1 ? 'room-sidebar-row--child room-sidebar-row--last' : 'room-sidebar-row--child'))}
              </div>
            ) : refRow(e.refs[0]))}
          </section>
        )}

        {media.notes.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Notes <span>{media.notes.length}</span></h3>
            {media.notes.map((n) => row(n.path, n.eventId, {
              href: n.url,
              title: n.title,
              sub: n.folder ?? day(n.timestamp),
              hover: n.path,
              icon: <span className="material-symbols-outlined room-sidebar-note-icon" aria-label="Obsidian note">description</span>,
            }))}
          </section>
        )}

        {linkGroups.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Links <span>{media.links.length}</span></h3>
            {linkGroups.map(([host, links]) => (
              <div key={host} className="room-sidebar-group">
                <div className="room-sidebar-host">{host}</div>
                {links.map((l) => row(l.url, l.eventId, {
                  href: l.url,
                  title: l.title ?? l.url.replace(/^https?:\/\/(www\.)?/, ''),
                  sub: day(l.timestamp),
                  hover: l.url,
                }))}
              </div>
            ))}
          </section>
        )}

        {media.images.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Images <span>{media.images.length}</span></h3>
            <div className="room-sidebar-images">
              {media.images.map((img) => {
                const url = mediaUrls[img.eventId]
                return url
                  ? <button key={img.eventId} type="button" className="room-sidebar-image" onClick={() => onOpenImage(url, img.name)}>
                      <img src={url} alt={img.name} loading="lazy" />
                    </button>
                  : <div key={img.eventId} className="room-sidebar-image room-sidebar-image--loading" />
              })}
            </div>
          </section>
        )}

        {media.files.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Files <span>{media.files.length}</span></h3>
            {media.files.map((f) => row(f.eventId, f.eventId, {
              href: mediaUrls[f.eventId],
              title: f.name,
              sub: day(f.timestamp),
              download: f.name,
            }))}
          </section>
        )}

        {media.places.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Places <span>{media.places.length}</span></h3>
            {media.places.map((p, i) => row(`${p.eventId}-${i}`, p.eventId, {
              href: mapsUrl(p.location),
              title: p.location.description ?? formatCoords(p.location),
              sub: day(p.timestamp),
            }))}
          </section>
        )}

        {hasMore && (
          <button type="button" className="room-sidebar-more" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading…' : 'Look further back'}
          </button>
        )}
      </div>
      )}
    </aside>
  )
}
