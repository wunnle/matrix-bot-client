import { useState } from 'react'
import type { ApprovalCard } from '../lib/approval'

interface Props {
  card: ApprovalCard
  /** The exact labels the card offered — sent back verbatim, which is how the bot reads the answer. */
  approve: string
  deny?: string
  always?: string
  /** Approves and turns on the room's auto mode, in one answer. */
  auto?: string
  onAnswer: (label: string) => void
  onView: () => void
}

/**
 * Stands in for the pill row while an approval card is the latest thing the
 * agent said: the decision you're being asked for, as buttons big enough to
 * hit without looking, instead of three pills among the room's own.
 *
 * Keyed by the card's event id by its parent, so a new card starts un-answered.
 */
export default function ApprovalBar({ card, approve, deny, always, auto, onAnswer, onView }: Props) {
  // One answer per card: the bar goes away when the reply lands, and a second
  // tap in between would read to the bot as an answer to whatever comes next.
  const [answered, setAnswered] = useState<string | null>(null)
  const answer = (label: string) => {
    if (answered) return
    setAnswered(label)
    onAnswer(label)
  }
  const detail = [card.target, card.reason].filter(Boolean).join(' · ')

  return (
    <div className="approval-bar" role="group" aria-label={`Approve ${card.tool}?`}>
      <div className="approval-bar-head">
        <span className="approval-bar-icon" aria-hidden>
          <span className="material-symbols-outlined">lock</span>
        </span>
        <span className="approval-bar-title">
          <span className="approval-bar-tool">{card.tool}</span>
          {detail && <span className="approval-bar-target">{detail}</span>}
        </span>
        <button type="button" className="approval-bar-view" onMouseDown={(e) => e.preventDefault()} onClick={onView}>
          View
        </button>
      </div>
      <div className={`approval-bar-actions${deny ? '' : ' approval-bar-actions--single'}`}>
        {deny && (
          <button
            type="button"
            className="approval-bar-btn approval-bar-btn--deny"
            disabled={answered !== null}
            // Same as the pills: a tap must not move focus to or from the composer.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => answer(deny)}
          >
            {answered === deny ? <span className="approval-bar-spinner" /> : deny}
          </button>
        )}
        <button
          type="button"
          className="approval-bar-btn approval-bar-btn--approve"
          disabled={answered !== null}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => answer(approve)}
        >
          {answered === approve
            ? <span className="approval-bar-spinner" />
            : <><span className="material-symbols-outlined" aria-hidden>check</span>{approve}</>}
        </button>
      </div>
      {always && (
        <button
          type="button"
          className="approval-bar-always"
          disabled={answered !== null}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => answer(always)}
        >
          {answered === always ? 'Allowing…' : `${always} ${card.tool} in this room`}
        </button>
      )}
      {auto && (
        <button
          type="button"
          className="approval-bar-always"
          disabled={answered !== null}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => answer(auto)}
        >
          {answered === auto ? 'Turning on auto mode…' : 'Approve and turn on auto mode'}
        </button>
      )}
    </div>
  )
}
