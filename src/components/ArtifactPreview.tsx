import { useEffect, useMemo, useState } from 'react'
import { getClient } from '../lib/matrix'
import { resolveMediaUrl } from '../lib/mediaUrl'
import type { ConstructArtifact } from '../types'

// claude.ai serves a published page inside this skeleton, so a page written
// for it has no doctype or head of its own; without one it renders in quirks
// mode. Links open outside the frame, as they do on claude.ai.
const SKELETON_HEAD =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  '<base target="_blank">' +
  '<style>body{margin:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}' +
  'img{max-width:100%}[hidden]{display:none!important}</style></head><body>'

function wrapArtifactPage(html: string): string {
  if (/^\s*(<!doctype|<html)/i.test(html)) {
    // A full document: only make its links leave the frame.
    return /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => `${m}<base target="_blank">`)
      : html
  }
  return `${SKELETON_HEAD}${html}</body></html>`
}

/**
 * The in-app copy of a page an agent published to claude.ai. Sandboxed with
 * scripts but no same-origin: the page runs, and can't reach the app, its
 * session or its storage. Features that need claude.ai itself (shared data,
 * comments, live sources) only work there.
 */
export default function ArtifactPreview({ snapshot, title }: {
  snapshot: NonNullable<ConstructArtifact['snapshot']>
  title: string
}) {
  const [html, setHtml] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // One page per mount: the sidebar keys this by the copy's mxc, so a new
  // version starts fresh rather than resetting state here.
  useEffect(() => {
    let live = true
    const encrypted = snapshot.file ? { file: snapshot.file, mimetype: 'text/html' } : undefined
    resolveMediaUrl(getClient(), snapshot.mxc, undefined, undefined, undefined, encrypted)
      .then((url) => (url ? fetch(url).then((r) => r.text()) : null))
      .then((text) => { if (live) { if (text) setHtml(text); else setFailed(true) } })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [snapshot.mxc, snapshot.file])

  const doc = useMemo(() => (html ? wrapArtifactPage(html) : null), [html])

  if (failed) return <p className="artifact-preview-note">Couldn't load the in-app copy. Open it on claude.ai instead.</p>
  if (!doc) return <div className="artifact-preview-loading" aria-label="Loading" />
  return (
    <iframe
      className="artifact-frame"
      title={title}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
    />
  )
}
