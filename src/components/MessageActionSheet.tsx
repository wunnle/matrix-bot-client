import { useEffect, useRef } from 'react'
import { hapticTick } from '../lib/haptics'
import type { Message } from '../types'

// The pair the old context menu carried: bots read them as yes / no.
const QUICK_REACTIONS = ['✅', '❎']

interface Props {
  msg: Message
  /** Author and send time, already formatted. */
  subtitle: string
  /** Plain text of the message, shown clamped so you can see which one you pressed. */
  preview: string
  userId: string
  isPinned: boolean
  pinInFlight: boolean
  onClose: () => void
  onReact: (eventId: string, emoji: string) => void
  onCopy: (body: string) => void
  onSelectText: (eventId: string) => void
  onTogglePin: (eventId: string) => void
  onInspect: (eventId: string) => void
}

/**
 * What a long-press on a message opens, on touch. Hover devices keep the inline
 * meta row instead — this exists because touch has no hover to reveal it on.
 */
export default function MessageActionSheet({
  msg,
  subtitle,
  preview,
  userId,
  isPinned,
  pinInFlight,
  onClose,
  onReact,
  onCopy,
  onSelectText,
  onTogglePin,
  onInspect,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The sheet opens while the finger that long-pressed is still down, right
  // under it. Lifting that finger must not count as a tap on the backdrop or on
  // whichever action it happens to be over, so nothing responds until it's up.
  const armedRef = useRef(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onUp = () => {
      // The click follows pointerup in a later task; wait it out.
      timer = setTimeout(() => { armedRef.current = true }, 300)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])
  const close = () => { if (armedRef.current) onClose() }

  // Every action closes the sheet; the tick confirms the tap landed.
  const act = (fn: () => void) => () => {
    if (!armedRef.current) return
    hapticTick()
    fn()
    onClose()
  }

  return (
    <div className="room-editor-overlay" onClick={close}>
      <div
        className="room-editor message-sheet"
        role="dialog"
        aria-label="Message actions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="message-sheet-head">
          <div className="message-sheet-subtitle">{subtitle}</div>
          {preview && <div className="message-sheet-preview">{preview}</div>}
        </div>

        <div className="message-sheet-reactions">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`message-sheet-reaction${msg.reactions?.[emoji]?.includes(userId) ? ' message-sheet-reaction--on' : ''}`}
              aria-label={`React ${emoji}`}
              onClick={act(() => onReact(msg.eventId, emoji))}
            >
              {emoji}
            </button>
          ))}
        </div>

        <div className="message-sheet-actions">
          <button type="button" className="message-sheet-action" onClick={act(() => onCopy(msg.body))}>
            <span className="material-symbols-outlined" aria-hidden>content_copy</span>
            Copy
          </button>
          <button type="button" className="message-sheet-action" onClick={act(() => onSelectText(msg.eventId))}>
            <span className="material-symbols-outlined" aria-hidden>text_select_start</span>
            Select text
          </button>
          <button
            type="button"
            className="message-sheet-action"
            disabled={pinInFlight}
            onClick={act(() => onTogglePin(msg.eventId))}
          >
            <span className="material-symbols-outlined" aria-hidden>keep</span>
            {isPinned ? 'Unpin' : 'Pin'}
          </button>
          <button type="button" className="message-sheet-action" onClick={act(() => onInspect(msg.eventId))}>
            <span className="material-symbols-outlined" aria-hidden>data_object</span>
            Inspect
          </button>
        </div>
      </div>
    </div>
  )
}
