import { Marked } from 'marked'

// Thread bodies are parsed here rather than arriving as HTML, so the diff and
// command renderers have to be repeated client-side — otherwise the full change
// behind an approval card would render as a flat, uncoloured block.
function escapeCode(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const threadMd = new Marked({
  renderer: {
    code(token: { lang?: string; text: string }) {
      if (token.lang === 'cmd') return `<pre><code class="cmd">${escapeCode(token.text)}</code></pre>`
      if (token.lang !== 'diff') return false
      const lines = token.text.split('\n').map((line) => {
        const cls = line.startsWith('+') ? 'diff-add'
          : line.startsWith('-') ? 'diff-del'
          : line.startsWith('#') ? 'diff-meta'
          : 'diff-ctx'
        const marked_ = cls !== 'diff-ctx'
        const mark = marked_ ? escapeCode(line[0]) : ''
        const rest = escapeCode(marked_ ? line.slice(1) : line) || '&nbsp;'
        return `<span class="${cls}"><span class="diff-mark">${mark}</span>${rest}</span>`
      })
      return `<pre><code class="diff">${lines.join('')}</code></pre>`
    },
  },
} as any)
