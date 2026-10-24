// Browser cards: a room message for each page an agent opens beside the chat
// (construct-browse). Construct draws `com.construct.browser` as a card, opens
// it in the room sidebar's Browser tab on a wide screen, and remembers it as
// the room's page (src/lib/browser.ts); other clients get the link.

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** The URL as Construct will open it, or null when it isn't an http(s) one. */
export function browserUrl(raw) {
  try {
    const u = new URL(String(raw))
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch { return null }
}

export function browserContent({ url, title }) {
  const label = title || new URL(url).host
  return {
    msgtype: 'm.text',
    body: `🌐 ${label}: ${url}`,
    format: 'org.matrix.custom.html',
    formatted_body: `🌐 <a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
    'com.construct.browser': { url, ...(title ? { title } : {}) },
    // The agent's reply says what it opened; the card shouldn't notify too.
    'com.construct.machine': { kind: 'notification', source: 'construct-browse' },
  }
}
