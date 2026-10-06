import { useState } from 'react'
import { formatModel } from '../lib/modelLabel'

interface Props {
  /** The room's model as the header shows it. */
  current: string | null
  /** The picker's [[options]], sent back verbatim. Empty while the bot has not answered yet. */
  options: string[]
  onPick: (option: string) => void
  onClose: () => void
}

// Agent rooms offer `!model claude-opus-5-5`; Hermes offers `/luna`.
function modelOptionLabel(option: string): string {
  const agent = /^!model\s+(\S+)$/.exec(option)
  if (agent) return formatModel(agent[1])
  const name = option.replace(/^\//, '')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Stands in for the pill row while a model picker is open: the header chip
 * asks the room's bot for its options, and its answer lands here as buttons
 * rather than as pills among the room's own.
 *
 * Keyed by the picker's event id by its parent, so a new picker starts un-picked.
 */
export default function ModelBar({ current, options, onPick, onClose }: Props) {
  // One pick per picker, as with the approval bar: the bar goes when the
  // confirmation lands, and a second tap before then would queue another switch.
  const [picked, setPicked] = useState<string | null>(null)
  const currentLabel = current ? formatModel(current) : null
  const isCurrent = (option: string) =>
    !!currentLabel && currentLabel.toLowerCase().includes(modelOptionLabel(option).toLowerCase())
  // Hermes lists every model, current one included; the agent bot leaves it
  // out. Put it back, checked, so both pickers read the same.
  const shown = current && options.length > 0 && options[0].startsWith('!model') && !options.some(isCurrent)
    ? [`!model ${current}`, ...options]
    : options

  return (
    <div className="approval-bar model-bar" role="group" aria-label="Switch model">
      <div className="approval-bar-head">
        <span className="approval-bar-icon model-bar-icon" aria-hidden>
          <span className="material-symbols-outlined">neurology</span>
        </span>
        <span className="approval-bar-title">
          <span className="approval-bar-tool">Switch model</span>
          {currentLabel && <span className="approval-bar-target">Now on {currentLabel}</span>}
        </span>
        <button
          type="button"
          className="model-bar-close"
          aria-label="Close model picker"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        >
          <span className="material-symbols-outlined" aria-hidden>close</span>
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="model-bar-loading">
          <span className="approval-bar-spinner" />
        </div>
      ) : (
        <div className="model-bar-options">
          {shown.map((option) => {
            const here = isCurrent(option)
            return (
              <button
                key={option}
                type="button"
                className={`approval-bar-btn model-bar-btn${here ? ' model-bar-btn--current' : ''}`}
                disabled={picked !== null || here}
                // Same as the pills: a tap must not move focus to or from the composer.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setPicked(option); onPick(option) }}
              >
                {picked === option
                  ? <span className="approval-bar-spinner" />
                  : <>
                      {here && <span className="material-symbols-outlined" aria-hidden>check</span>}
                      {modelOptionLabel(option)}
                    </>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
