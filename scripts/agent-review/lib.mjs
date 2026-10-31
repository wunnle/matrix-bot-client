// Shared by the agent-review collectors: they turn a week of agent logs into a
// short findings file for the reviewing agent to verify, so the expensive part
// (a Claude turn) reads a few kilobytes instead of the raw logs.
import { execFile } from 'node:child_process'

export const DAY_MS = 24 * 60 * 60 * 1000

// Sinan writes in English and Turkish. These mark a reply that pushes back on
// the agent's last answer; noisy on purpose, the reviewer verifies each one.
const CORRECTION = [
  /\b(no|nope|wrong|incorrect|not what|that's not|that isn't|stop|don't|didn't (i|you)|why (can't|cant|didn't|did you|not|is it|are you|do you)|i (said|told|asked|meant)|just (find|do|tell|use|give)|again|instead|still (not|broken|wrong|failing))\b/i,
  /\b(hayır|yanlış|neden|niye|dedim|değil|tekrar|olmamış|olmadı|yapma|hala|hâlâ|sadece)\b/i,
]
export const isCorrection = (text) => CORRECTION.some((re) => re.test(text))

// Answers that stop short instead of finding another way.
const GAVE_UP = /\b(i (couldn't|could not|can't|cannot|wasn't able to|was unable to)|unable to (verify|find|access|reach)|no way to|don't have access)\b|yapamadım|bulamadım|erişemiyorum/i
export const gaveUp = (text) => GAVE_UP.test(text)

export function clip(text, n = 280) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '').trim() }))
  })
}

// A section is only written when it has items, and the item count is what
// decides whether the week was quiet.
export function createReport(title, days) {
  const sections = []
  return {
    section(heading, items, note = '') {
      if (items.length) sections.push({ heading, items, note })
    },
    get count() { return sections.reduce((n, s) => n + s.items.length, 0) },
    markdown() {
      const out = [`# ${title}`, '', `Window: last ${days} days, generated ${new Date().toISOString()}.`,
        'Every item is a mechanical signal, not a conclusion. Verify before suggesting anything.', '']
      for (const s of sections) {
        out.push(`## ${s.heading} (${s.items.length})`, '')
        if (s.note) out.push(s.note, '')
        for (const item of s.items) out.push(`- ${item}`)
        out.push('')
      }
      if (!sections.length) out.push('Nothing flagged.')
      return out.join('\n')
    },
  }
}
