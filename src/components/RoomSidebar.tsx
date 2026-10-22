import { useMemo, type ReactNode } from 'react'
import { isEmptyRoomMedia, type RoomLink, type RoomMedia } from '../lib/roomMedia'
import { mapsUrl, formatCoords } from '../lib/location'
import ArtifactPreview from './ArtifactPreview'

// Brand marks (Simple Icons), drawn in the text colour.
const LINEAR_PATH = 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z'
const GITHUB_PATH = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'

const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/**
 * A room's side panel: what was shared in it (issues and PRs, Obsidian notes,
 * links, images, files, places), collected from the loaded
 * messages. A column beside the chat on wide screens, a full sheet on the
 * phone. A row opens its thing; "In chat" under it finds the message it came from.
 * When agents published pages to claude.ai, an Artifacts tab shows them, one
 * at a time, from the copy the bot keeps (claude.ai itself can't be framed).
 */
export type SidebarTab = 'artifacts' | 'shared'

export default function RoomSidebar({ media, mediaUrls, hasMore, loadingMore, onLoadMore, onJump, onOpenImage, onClose, tab, onTab, openArtifact, onOpenArtifact }: {
  media: RoomMedia
  /** Resolved image/file URLs by event id. */
  mediaUrls: Record<string, string>
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onJump: (eventId: string) => void
  onOpenImage: (url: string, alt: string) => void
  onClose: () => void
  tab: SidebarTab
  onTab: (tab: SidebarTab) => void
  /** The artifact shown, by id; null for the list, undefined for the newest. */
  openArtifact: string | null | undefined
  onOpenArtifact: (id: string | null) => void
}) {
  // No artifacts, no tab: the panel is what it always was.
  const hasArtifacts = media.artifacts.length > 0
  const current = hasArtifacts && tab === 'artifacts' ? 'artifacts' : 'shared'
  const shown = current === 'artifacts' && openArtifact !== null
    ? media.artifacts.find((a) => a.id === openArtifact) ?? media.artifacts[0]
    : null
  // Links by site, sites in order of their newest link.
  const linkGroups = useMemo(() => {
    const groups = new Map<string, RoomLink[]>()
    for (const l of media.links) groups.set(l.host, [...(groups.get(l.host) ?? []), l])
    return [...groups.entries()]
  }, [media.links])

  // The link stretches over the whole row (see .room-sidebar-link::after);
  // "In chat" sits above it, so it is the one spot that does something else.
  const row = (key: string, eventId: string, { href, onOpen, title, sub, icon, download, hover }: {
    href?: string
    /** Opens it here in the panel instead of following a link. */
    onOpen?: () => void
    title: string
    sub?: string
    icon?: ReactNode
    download?: string
    hover?: string
  }) => (
    <div key={key} className="room-sidebar-row">
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
  // Artifacts have their own tab; the Shared one is empty without the rest.
  const empty = isEmptyRoomMedia({ ...media, artifacts: [] })

  return (
    <aside className={`room-sidebar${shown ? ' room-sidebar--wide' : ''}`} aria-label="Shared in this room">
      <div className="room-sidebar-header">
        {hasArtifacts ? (
          <div className="room-sidebar-tabs" role="tablist" aria-label="Side panel">
            <button
              type="button" role="tab" aria-selected={current === 'artifacts'}
              className={`room-sidebar-tab${current === 'artifacts' ? ' room-sidebar-tab--on' : ''}`}
              onClick={() => onTab('artifacts')}
            >
              Artifacts <span>{media.artifacts.length}</span>
            </button>
            <button
              type="button" role="tab" aria-selected={current === 'shared'}
              className={`room-sidebar-tab${current === 'shared' ? ' room-sidebar-tab--on' : ''}`}
              onClick={() => onTab('shared')}
            >
              Shared
            </button>
          </div>
        ) : (
          <span className="room-sidebar-title">Shared</span>
        )}
        <button type="button" className="room-sidebar-close" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      {shown ? (
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
            : <p className="artifact-preview-note">There's no in-app copy of this page: it was published with supporting files, or posted as a plain link. Open it on claude.ai.</p>}
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

        {media.refs.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Issues &amp; PRs <span>{media.refs.length}</span></h3>
            {media.refs.map((r) => row(r.label, r.eventId, {
              href: r.url,
              title: r.label,
              sub: r.title && r.title !== r.label ? r.title : day(r.timestamp),
              icon: (
                <svg className="room-sidebar-ref-icon" viewBox="0 0 24 24" role="img" aria-label={r.kind === 'linear' ? 'Linear' : 'GitHub'}>
                  <path d={r.kind === 'linear' ? LINEAR_PATH : GITHUB_PATH} />
                </svg>
              ),
            }))}
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
