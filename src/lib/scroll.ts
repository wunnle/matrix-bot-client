/**
 * Scroll a container to its true end.
 *
 * scrollIntoView on the bottom sentinel aligns that zero-height div, which
 * leaves whatever sits below it — a collapsed bottom margin on the last block,
 * the container's own padding — still scrollable, so entering a room landed a
 * few pixels short. The arithmetic has no such gap.
 */
export function scrollToEnd(el: HTMLElement | null, behavior: ScrollBehavior = 'instant') {
  if (!el) return
  el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior })
}

// The scrollbar lives inside the block's border box but outside its client
// box, so a hit below/right of the client box is the bar, not the code.
export const isOnScrollbar = (block: HTMLElement, e: { clientX: number; clientY: number }) => {
  const rect = block.getBoundingClientRect()
  return (
    e.clientY >= rect.top + block.clientTop + block.clientHeight ||
    e.clientX >= rect.left + block.clientLeft + block.clientWidth
  )
}

/**
 * Where you left a room, kept across the room being unmounted (only the last
 * few rooms stay mounted) and across reloads. Stored as the first message row
 * on screen plus how far its top sat from the list's top, not as a scrollTop:
 * the list above that row grows and shrinks between visits (more history
 * paged in, images loading), so a raw offset would land somewhere else.
 * No entry means "at the end".
 */
export type ScrollAnchor = { eventId: string; offset: number }

const anchorKey = (roomId: string) => `construct.scroll.${roomId}`

export function loadScrollAnchor(roomId: string): ScrollAnchor | null {
  try {
    const v = JSON.parse(localStorage.getItem(anchorKey(roomId)) ?? 'null')
    return v && typeof v.eventId === 'string' && typeof v.offset === 'number' ? v : null
  } catch {
    return null
  }
}

export function saveScrollAnchor(roomId: string, anchor: ScrollAnchor | null) {
  try {
    if (anchor) localStorage.setItem(anchorKey(roomId), JSON.stringify(anchor))
    else localStorage.removeItem(anchorKey(roomId))
  } catch { /* storage unavailable */ }
}

/** The first message row whose bottom is below the list's top edge. */
export function readScrollAnchor(list: HTMLElement): ScrollAnchor | null {
  const top = list.getBoundingClientRect().top
  for (const row of list.querySelectorAll<HTMLElement>('[data-event-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > top) return { eventId: row.dataset.eventId!, offset: rect.top - top }
  }
  return null
}

/** Put the anchor row back where it was. False when the row is not rendered. */
export function applyScrollAnchor(list: HTMLElement, anchor: ScrollAnchor): boolean {
  const row = list.querySelector<HTMLElement>(`[data-event-id="${window.CSS.escape(anchor.eventId)}"]`)
  if (!row) return false
  const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset
  list.scrollTop += delta
  return true
}
