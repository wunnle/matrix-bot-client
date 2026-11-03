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
