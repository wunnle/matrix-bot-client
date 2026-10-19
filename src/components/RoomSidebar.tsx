import { useMemo } from 'react'
import { isEmptyRoomMedia, type RoomLink, type RoomMedia } from '../lib/roomMedia'
import { mapsUrl, formatCoords } from '../lib/location'

const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/**
 * A room's side panel: what was shared in it, collected from the loaded
 * messages. A column beside the chat on wide screens, a full sheet on the
 * phone. Rows open their thing; the bubble button finds the message it came from.
 */
export default function RoomSidebar({ media, mediaUrls, hasMore, loadingMore, onLoadMore, onJump, onOpenImage, onClose }: {
  media: RoomMedia
  /** Resolved image/file URLs by event id. */
  mediaUrls: Record<string, string>
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onJump: (eventId: string) => void
  onOpenImage: (url: string, alt: string) => void
  onClose: () => void
}) {
  // Links by site, sites in order of their newest link.
  const linkGroups = useMemo(() => {
    const groups = new Map<string, RoomLink[]>()
    for (const l of media.links) groups.set(l.host, [...(groups.get(l.host) ?? []), l])
    return [...groups.entries()]
  }, [media.links])

  const jump = (eventId: string) => (
    <button type="button" className="room-sidebar-jump" title="Show in chat" aria-label="Show in chat" onClick={() => onJump(eventId)}>
      <span className="material-symbols-outlined" aria-hidden>chat_bubble</span>
    </button>
  )
  const empty = isEmptyRoomMedia(media)

  return (
    <aside className="room-sidebar" aria-label="Shared in this room">
      <div className="room-sidebar-header">
        <span className="room-sidebar-title">Shared</span>
        <button type="button" className="room-sidebar-close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="room-sidebar-body">
        {empty && <p className="room-sidebar-empty">Nothing shared in the loaded messages yet.</p>}

        {media.refs.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Issues &amp; PRs <span>{media.refs.length}</span></h3>
            {media.refs.map((r) => (
              <div key={r.label} className="room-sidebar-row">
                <a className="room-sidebar-link" href={r.url} target="_blank" rel="noopener noreferrer">
                  <span className="room-sidebar-ref-kind">{r.kind === 'linear' ? 'Linear' : 'GitHub'}</span>
                  <span className="room-sidebar-link-title">{r.label}</span>
                  {r.title && r.title !== r.label && <span className="room-sidebar-link-sub">{r.title}</span>}
                </a>
                {jump(r.eventId)}
              </div>
            ))}
          </section>
        )}

        {linkGroups.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Links <span>{media.links.length}</span></h3>
            {linkGroups.map(([host, links]) => (
              <div key={host} className="room-sidebar-group">
                <div className="room-sidebar-host">{host}</div>
                {links.map((l) => (
                  <div key={l.url} className="room-sidebar-row">
                    <a className="room-sidebar-link" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
                      <span className="room-sidebar-link-title">{l.title ?? l.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
                      <span className="room-sidebar-link-sub">{day(l.timestamp)}</span>
                    </a>
                    {jump(l.eventId)}
                  </div>
                ))}
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
            {media.files.map((f) => {
              const url = mediaUrls[f.eventId]
              return (
                <div key={f.eventId} className="room-sidebar-row">
                  <a className="room-sidebar-link" href={url} download={f.name} target="_blank" rel="noreferrer" aria-disabled={!url}>
                    <span className="room-sidebar-link-title">{f.name}</span>
                    <span className="room-sidebar-link-sub">{day(f.timestamp)}</span>
                  </a>
                  {jump(f.eventId)}
                </div>
              )
            })}
          </section>
        )}

        {media.places.length > 0 && (
          <section className="room-sidebar-section">
            <h3>Places <span>{media.places.length}</span></h3>
            {media.places.map((p, i) => (
              <div key={`${p.eventId}-${i}`} className="room-sidebar-row">
                <a className="room-sidebar-link" href={mapsUrl(p.location)} target="_blank" rel="noopener noreferrer">
                  <span className="room-sidebar-link-title">{p.location.description ?? formatCoords(p.location)}</span>
                  <span className="room-sidebar-link-sub">{day(p.timestamp)}</span>
                </a>
                {jump(p.eventId)}
              </div>
            ))}
          </section>
        )}

        {hasMore && (
          <button type="button" className="room-sidebar-more" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading…' : 'Look further back'}
          </button>
        )}
      </div>
    </aside>
  )
}
