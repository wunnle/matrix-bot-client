/**
 * [[CTA]] quick-reply buttons in bot messages. Shared by the chat's pill row
 * (ChatView) and the in-app toast (RoomToast), so a message offers the same
 * buttons wherever it shows up.
 */

import { formatModel } from './modelLabel'

/** What a pill shows for an action; the action itself is still what's sent. */
export function actionLabel(action: string): string {
  const model = /^!model\s+(\S+)$/.exec(action)
  return model ? formatModel(model[1]) : action
}

// Doc examples like [[label]] or <code>[[button]]</code> — not real CTAs
export function isActionPlaceholder(inner: string): boolean {
  const t = inner.trim().toLowerCase()
  return t === 'label' || t === 'button'
}

// Markdown code, fenced or inline. Fences are matched first so a backtick
// inside a ``` block can't open a phantom inline span.
const MD_CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g

/**
 * Split markdown into alternating prose and code runs, in order. Code runs are
 * handed back verbatim so callers can leave them untouched.
 */
export function splitMarkdownCode(body: string): { text: string; isCode: boolean }[] {
  const out: { text: string; isCode: boolean }[] = []
  let i = 0
  MD_CODE.lastIndex = 0
  for (;;) {
    const m = MD_CODE.exec(body)
    if (!m) {
      out.push({ text: body.slice(i), isCode: false })
      break
    }
    out.push({ text: body.slice(i, m.index), isCode: false })
    out.push({ text: m[0], isCode: true })
    i = m.index + m[0].length
  }
  return out
}

const TOKEN = /\[\[([^\]\n]{1,40})\]\]/g
// The run of [[CTA]] tokens a message ends with, across lines.
const TRAILING_TOKENS = /(?:\s*\[\[[^\]\n]{1,40}\]\])+\s*$/

/**
 * What an inline [[…]] reads as: agents that write notes (Lore) put Obsidian
 * wikilinks in chat — "[[Note]]", "[[Note|shown text]]" — and those are names
 * in a sentence, not buttons.
 */
export function wikilinkText(inner: string): string {
  const bar = inner.indexOf('|')
  return (bar >= 0 ? inner.slice(bar + 1) : inner).trim()
}

/**
 * Pull trailing [[CTA]] tokens out of a message body into tappable pills.
 * Only the ones the message ends with: a [[…]] mid-sentence is a wikilink and
 * keeps its place as plain text. Taking every token turned "The [[Colonist]]
 * retreat is at…" into "The  retreat is at…" plus a "Colonist" button.
 *
 * Code is exempt: a message *documenting* the syntax — a fenced example, an
 * inline `[[label]]` — must not sprout buttons from its own sample text. The
 * rich-HTML path (stripActionMarkersInRichHtml) has always honoured that for
 * <code>; this is the same rule on the plain-text side, which is what actually
 * feeds the pill row.
 */
export function parseActions(body: string): { text: string; actions: string[] } {
  const actions: string[] = []
  const segs = splitMarkdownCode(body)
  const last = segs[segs.length - 1]
  if (last && !last.isCode) {
    last.text = last.text.replace(TRAILING_TOKENS, (run) => {
      const kept = run.replace(TOKEN, (match, label: string) => {
        if (isActionPlaceholder(label)) return match
        actions.push(label.trim())
        return ''
      })
      return kept.trim() ? kept : ''
    })
  }
  const text = segs
    .map(({ text: seg, isCode }) => isCode
      ? seg
      : seg.replace(TOKEN, (match, inner: string) => isActionPlaceholder(inner) ? match : wikilinkText(inner)))
    .join('')
    .trim()
  return { text, actions }
}

const CODE_BLOCK = /<code(\s[^>]*)?>[\s\S]*?<\/code>/gi
const HTML_TOKEN = /\[\[([^\]<\n]{1,40})\]\]/g
// The [[CTA]] run the HTML ends with (line breaks between tokens allowed),
// then the closing tags after it, which stay.
const TRAILING_HTML_TOKENS = /(?:(?:\s|<br\s*\/?>)*\[\[[^\]<\n]{1,40}\]\])+((?:\s|<\/[a-z0-9]+>)*)$/i

/**
 * The HTML side of parseActions: the trailing [[CTA]] run goes (it's the pill
 * row), any other [[…]] outside <code> reads as plain text. [[...]] inside
 * <code> are docs and stay as written.
 */
export function stripActionMarkersInRichHtml(html: string): string {
  const out: string[] = []
  let i = 0
  CODE_BLOCK.lastIndex = 0
  for (;;) {
    const m = CODE_BLOCK.exec(html)
    if (!m) {
      out.push(inlineWikilinksAsText(stripTrailingActionMarkers(html.slice(i))))
      break
    }
    out.push(inlineWikilinksAsText(html.slice(i, m.index)))
    out.push(m[0])
    i = m.index + m[0].length
  }
  return out.join('')
}

function stripTrailingActionMarkers(s: string): string {
  return s.replace(TRAILING_HTML_TOKENS, (run, closing: string) => {
    const tokens = run.slice(0, run.length - closing.length).match(HTML_TOKEN) ?? []
    // Placeholders are docs; leave the run alone rather than half-strip it.
    return tokens.some((t) => isActionPlaceholder(t.slice(2, -2))) ? run : closing
  })
}

function inlineWikilinksAsText(s: string): string {
  return s.replace(HTML_TOKEN, (match, inner: string) => isActionPlaceholder(inner) ? match : wikilinkText(inner))
}
