// `hr` earns its place: a `---` is how a reply marks a section break, and
// stripping the tag silently collapsed two sections into one wall of text.
const ALLOWED_TAGS = /^(p|br|hr|strong|b|em|i|u|s|del|code|pre|ul|ol|li|blockquote|h[1-6]|a|span|table|thead|tbody|tr|th|td)$/i
const ALLOWED_ATTRS: Record<string, string[]> = { a: ['href', 'target', 'rel'], span: ['class'], code: ['class'] }
// Class names are an allowlist, not free text: the bot marks up diff lines with
// these and nothing else may borrow the app's styling.
const ALLOWED_CLASSES = /^(diff|diff-add|diff-del|diff-meta|diff-ctx|diff-mark|cmd)$/

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  function clean(node: Node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      if (!ALLOWED_TAGS.test(el.tagName)) {
        el.replaceWith(...Array.from(el.childNodes))
        return
      }
      const allowed = ALLOWED_ATTRS[el.tagName.toLowerCase()] ?? []
      for (const attr of Array.from(el.attributes)) {
        if (!allowed.includes(attr.name)) el.removeAttribute(attr.name)
      }
      const cls = el.getAttribute('class')
      if (cls !== null && !ALLOWED_CLASSES.test(cls)) el.removeAttribute('class')
      if (el.tagName.toLowerCase() === 'a') {
        const href = el.getAttribute('href') ?? ''
        if (href.startsWith('javascript:')) el.removeAttribute('href')
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      }
      Array.from(el.childNodes).forEach(clean)
    }
  }
  Array.from(doc.body.childNodes).forEach(clean)
  return doc.body.innerHTML
}
