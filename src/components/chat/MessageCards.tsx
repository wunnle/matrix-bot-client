import React, { useMemo } from 'react'
import type { Message, ConstructThread, SubagentCard, ConstructArtifact } from '../../types'
import { sanitizeHtml } from '../../lib/sanitizeHtml'
import { threadMd } from '../../lib/threadMarkdown'
import { formatDuration } from '../../lib/chatFormat'
import { formatCoords, mapsUrl, mapTiles, MAP_ATTRIBUTION } from '../../lib/location'
import { ArtifactOpenContext, BrowserOpenContext } from './openContexts'

export function ThreadBlock({ thread }: { thread: ConstructThread }) {
  const [expanded, setExpanded] = React.useState(false)
  const bodyHtml = React.useMemo(
    () => sanitizeHtml(threadMd.parse(thread.body, { async: false }) as string),
    [thread.body]
  )
  return (
    <div className={`msg-thread${expanded ? ' msg-thread--open' : ''}`}>
      <button className="msg-thread-header" onClick={() => setExpanded(v => !v)}>
        <span className="material-icons msg-thread-chevron">chevron_right</span>
        <span className="msg-thread-title">{thread.title}</span>
      </button>
      {!expanded && thread.summary && (
        <div className="msg-thread-summary">{thread.summary}</div>
      )}
      {expanded && (
        <div
          className="msg-thread-body bot-text bot-text-rich"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
    </div>
  )
}

// Running shows the live dot instead; its entry is never drawn.
const SUBAGENT_ICON: Record<SubagentCard['status'], string> = {
  running: 'pending',
  completed: 'check_circle',
  failed: 'error',
  stopped: 'stop_circle',
}

// A subagent the agent handed work to: what it's doing while it runs, its
// report once it's done. Collapsed by default; the card is edited in place, so
// this re-renders as the bot sends each snapshot.
export function SubagentBlock({ card }: { card: SubagentCard }) {
  const [expanded, setExpanded] = React.useState(false)
  const running = card.status === 'running'
  // Snapshots come every few seconds at best; the clock shouldn't wait on them.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!running || !card.startedAt) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [running, card.startedAt])
  const elapsed = running && card.startedAt ? Math.max(card.durationMs ?? 0, now - card.startedAt) : card.durationMs
  const summaryHtml = React.useMemo(
    () => (card.summary ? sanitizeHtml(threadMd.parse(card.summary, { async: false }) as string) : ''),
    [card.summary]
  )
  const latest = card.lines[card.lines.length - 1]
  const meta = [
    card.toolUses > 0 && `${card.toolUses} ${card.toolUses === 1 ? 'tool' : 'tools'}`,
    elapsed !== undefined && elapsed > 0 && formatDuration(elapsed),
  ].filter(Boolean).join(' · ')
  // Collapsed, the second line is what it's doing now, or how it ended.
  const peek = running
    ? latest && `${latest.tool}${latest.content ? ` · ${latest.content}` : ''}`
    : card.summary?.split('\n').find((l) => l.trim())?.replace(/[*_`#>]/g, '').trim()
  return (
    <div className={`subagent-card subagent-card--${card.status}${expanded ? ' subagent-card--open' : ''}`}>
      <button className="subagent-card-header" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        {running
          ? <span className="tool-progress-live-dot subagent-card-live" aria-label="Running" />
          : <span className="material-icons subagent-card-icon" aria-label={card.status}>{SUBAGENT_ICON[card.status]}</span>}
        <span className="subagent-card-heading">
          <span className="subagent-card-title">{card.description}</span>
          {(card.agentType || meta) && (
            <span className="subagent-card-meta">
              {card.agentType && <span className="subagent-card-type">{card.agentType}</span>}
              {meta}
            </span>
          )}
          {!expanded && peek && <span className="subagent-card-peek">{peek}</span>}
        </span>
        <span className="material-icons subagent-card-chevron">chevron_right</span>
      </button>
      {expanded && (
        <div className="subagent-card-body">
          {card.lines.length > 0 && (
            <div className="subagent-card-lines">
              {card.toolUses > card.lines.length && (
                <div className="subagent-card-earlier">{card.toolUses - card.lines.length} earlier</div>
              )}
              {card.lines.map((l, i) => (
                <div key={i} className="tool-progress-line">
                  <span className="tool-progress-emoji">{l.emoji}</span>
                  <span className="tool-progress-tool">{l.tool}</span>
                  {l.content !== undefined && <span className="tool-progress-content">{l.content}</span>}
                </div>
              ))}
            </div>
          )}
          {summaryHtml
            ? <div className="subagent-card-summary bot-text" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
            : !running && card.lines.length === 0 && <div className="subagent-card-earlier">No report.</div>}
        </div>
      )}
    </div>
  )
}

// A page an agent published to claude.ai. A tap opens it in the side panel
// (from the copy the bot keeps); the link itself still goes to claude.ai, for
// a long-press or a new tab.
export function ArtifactBlock({ artifact }: { artifact: ConstructArtifact }) {
  const open = React.useContext(ArtifactOpenContext)
  return (
    <a
      className="artifact-card"
      href={artifact.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={open ? (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        open(artifact.url)
      } : undefined}
    >
      <span className="material-symbols-outlined artifact-card-icon" aria-hidden="true">article</span>
      <span className="artifact-card-text">
        <span className="artifact-card-title">{artifact.title}</span>
        {artifact.description && <span className="artifact-card-description">{artifact.description}</span>}
        <span className="artifact-card-meta">claude.ai{artifact.version && artifact.version > 1 ? ` · version ${artifact.version}` : ''}</span>
      </span>
      <span className="material-icons artifact-card-open" aria-hidden="true">open_in_new</span>
    </a>
  )
}

// A page an agent opened beside the chat (construct-browse). A tap shows it in
// the Browser tab again; the link itself still goes to the page.
export function BrowserBlock({ page }: { page: NonNullable<Message['browser']> }) {
  const open = React.useContext(BrowserOpenContext)
  const host = new URL(page.url).host
  return (
    <a
      className="artifact-card"
      href={page.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={open ? (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        open(page.url)
      } : undefined}
    >
      <span className="material-symbols-outlined artifact-card-icon" aria-hidden="true">language</span>
      <span className="artifact-card-text">
        <span className="artifact-card-title">{page.title ?? host}</span>
        <span className="artifact-card-meta">{page.title ? `${host} · ` : ''}Open beside the chat</span>
      </span>
      <span className="material-icons artifact-card-open" aria-hidden="true">chevron_right</span>
    </a>
  )
}

// Fixed so the tiles can be laid out without measuring; CSS caps the width.
const MAP_W = 264
const MAP_H = 140
const MAP_ZOOM = 16

// A shared location: a map tile preview with a pin, and the coordinates under
// it. Tap opens it in Google Maps.
export function LocationLink({ location }: { location: NonNullable<Message['location']> }) {
  const tiles = useMemo(() => mapTiles(location, MAP_ZOOM, MAP_W, MAP_H), [location])
  return (
    <a
      href={mapsUrl(location)}
      className="msg-location"
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="msg-location-map" style={{ width: MAP_W, height: MAP_H }} aria-hidden>
        {tiles.map((t) => (
          <img key={t.url} src={t.url} alt="" draggable={false} loading="lazy" style={{ left: t.x, top: t.y }} />
        ))}
        <span className="material-icons msg-location-pin">location_on</span>
        <span className="msg-location-attribution">{MAP_ATTRIBUTION}</span>
      </span>
      <span className="msg-location-text">
        <span className="msg-location-title">{location.description ?? 'Location'}</span>
        <span className="msg-location-coords">
          {formatCoords(location)}{location.accuracy != null && ` · ±${location.accuracy} m`}
        </span>
      </span>
    </a>
  )
}
