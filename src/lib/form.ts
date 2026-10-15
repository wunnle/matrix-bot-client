import type { ConstructForm, ConstructFormResponse } from '../types'

// How an agent asks a multiple-choice question: a fenced block in its reply,
// rendered as a checklist with a Submit button.
//   ```form
//   {"question": "Which ones?", "options": ["A", {"label": "B", "description": "…"}]}
//   ```
// Always pick-any: pick-one is what [[quick answers]] are for. Text, like ```location, so any agent can
// send one from a plain reply; other clients just show the JSON. One form per
// message: the first block that parses wins.
const FORM_FENCE = /```form[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?\n?/
const FORM_HTML = /<pre><code class="language-form">[\s\S]*?<\/code><\/pre>\s*/

const MAX_OPTIONS = 12
const MAX_LABEL = 80

function parseForm(json: string): ConstructForm | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const o = parsed as Record<string, unknown>
  if (!Array.isArray(o.options)) return undefined
  const options = o.options.map((item) => {
    const raw = typeof item === 'string' ? { label: item } : item as Record<string, unknown> | null
    const label = typeof raw?.label === 'string' ? raw.label.trim() : ''
    if (!label || label.length > MAX_LABEL || label.includes('\n')) return undefined
    const description = typeof raw?.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined
    return description ? { label, description } : { label }
  })
  const labels = new Set(options.map((opt) => opt?.label))
  if (options.length < 2 || options.length > MAX_OPTIONS || !options.every(Boolean) || labels.size !== options.length) return undefined
  const question = typeof o.question === 'string' && o.question.trim() ? o.question.trim() : undefined
  return { question, options: options as ConstructForm['options'] }
}

// The form in a message's ```form block, and its body and HTML with the block
// taken out. A block that doesn't parse is left in place, so a mistake shows
// up as text rather than vanishing.
export function extractFormBlock(body: string, html?: string) {
  const m = body.includes('```form') ? FORM_FENCE.exec(body) : null
  const form = m ? parseForm(m[1]) : undefined
  if (!m || !form) return { form: undefined, body, html }
  return {
    form,
    body: (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim(),
    html: html?.replace(FORM_HTML, ''),
  }
}

// Marks a message as the answer to a form, so the form shows what was picked
// and stops taking answers.
export const FORM_RESPONSE_KEY = 'com.construct.form_response'

export function formResponseFromContent(content: Record<string, unknown> | undefined): ConstructFormResponse | undefined {
  const raw = content?.[FORM_RESPONSE_KEY] as Record<string, unknown> | undefined
  if (!raw || typeof raw.event_id !== 'string' || !Array.isArray(raw.picked)) return undefined
  return { eventId: raw.event_id, picked: raw.picked.filter((p): p is string => typeof p === 'string') }
}

// The answer as the agent reads it: the question repeated, so a reply landing
// in a fresh session (a webhook-sent form) still makes sense on its own.
export function formAnswerBody(form: ConstructForm, picked: string[]): string {
  const answer = picked.join(', ')
  return form.question ? `${form.question}\n→ ${answer}` : answer
}
