import { useEffect, useState } from 'react'
import type { ConstructForm } from '../../types'
import { actionLabel, choiceLetter } from '../../lib/actions'

// An agent's ```form: tick what applies, then Submit. Drawn with the lettered
// list's rows (ChoiceList), a ticked one showing a check in its key; once
// answered it collapses to your picks, read-only, as a list does.
export function FormCard({ form, answer, onSubmit }: {
  form: ConstructForm
  answer?: string
  onSubmit: (picked: string[]) => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  // Locks the form from the tap until the answer comes back from the server;
  // if it never does (the send failed), it opens up again.
  const [sentAt, setSentAt] = useState(0)
  useEffect(() => {
    if (!sentAt || answer !== undefined) return
    const t = setTimeout(() => setSentAt(0), 15_000)
    return () => clearTimeout(t)
  }, [sentAt, answer])
  const done = answer !== undefined || sentAt > 0
  const shown = answer !== undefined ? answer.split('\n') : picked
  const toggle = (label: string) => {
    if (done) return
    setPicked((cur) => cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
  }
  return (
    <div className={`msg-form${done ? ' msg-form--done' : ''}`} onClick={(e) => e.stopPropagation()}>
      {form.question && <div className="msg-form-question">{form.question}</div>}
      <div className={`msg-choices${done ? ' msg-choices--done' : ''}`} role="group">
        {form.options.map((opt, i) => {
          const on = shown.includes(opt.label)
          return (
            <button
              key={opt.label}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={done}
              className={`msg-choice${on ? ' msg-choice--on' : ''}`}
              onClick={() => toggle(opt.label)}
            >
              <span className="msg-choice-key" aria-hidden>
                {on ? <span className="material-symbols-outlined msg-form-check">check</span> : choiceLetter(i)}
              </span>
              <span className="msg-form-text">
                <span className="msg-choice-label">{opt.label}</span>
                {opt.description && <span className="msg-form-description">{opt.description}</span>}
              </span>
            </button>
          )
        })}
      </div>
      {done
        ? answer === undefined && <div className="msg-form-status">Sending…</div>
        : (
          <button
            type="button"
            className="msg-form-submit"
            disabled={!picked.length}
            onClick={() => {
              // Options order, not tap order: reads the way the question did.
              const ordered = form.options.map((o) => o.label).filter((l) => picked.includes(l))
              setSentAt(Date.now())
              onSubmit(ordered)
            }}
          >
            Submit
          </button>
        )}
    </div>
  )
}

// A bot message's [[…]] answers: a lettered list under its text. A tap sends
// the option, as a pill would, and so does its letter key while no text field
// has focus. Once answered it collapses to the pick; unanswered, it fades.
export function ChoiceList({ actions, open, picked, onPick }: {
  actions: string[]
  open: boolean
  picked?: string
  onPick: (label: string) => void
}) {
  return (
    <div className={`msg-choices${open ? '' : ' msg-choices--done'}`} role="group" onClick={(e) => e.stopPropagation()}>
      {actions.map((action, i) => (
        <button
          key={action}
          type="button"
          className={`msg-choice${action === picked ? ' msg-choice--on' : ''}`}
          disabled={!open}
          // Like the pills: a tap must not move focus to or from the composer.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(action)}
        >
          <span className="msg-choice-key" aria-hidden>{choiceLetter(i)}</span>
          <span className="msg-choice-label">{actionLabel(action)}</span>
        </button>
      ))}
    </div>
  )
}
