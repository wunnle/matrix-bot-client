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

/**
 * Pull trailing [[CTA]] tokens out of a message body into tappable pills.
 *
 * Code is exempt: a message *documenting* the syntax — a fenced example, an
 * inline `[[label]]` — must not sprout buttons from its own sample text. The
 * rich-HTML path (stripActionMarkersInRichHtml) has always honoured that for
 * <code>; this is the same rule on the plain-text side, which is what actually
 * feeds the pill row.
 */
export function parseActions(body: string): { text: string; actions: string[] } {
  const actions: string[] = []
  const text = splitMarkdownCode(body)
    .map(({ text: seg, isCode }) => {
      if (isCode) return seg
      return seg.replace(/\[\[([^\]]{1,40})\]\]/g, (match, label) => {
        if (isActionPlaceholder(label)) return match
        actions.push(label.trim())
        return ''
      })
    })
    .join('')
    .trim()
  return { text, actions }
}
