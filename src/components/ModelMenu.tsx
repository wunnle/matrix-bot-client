import type { CSSProperties } from 'react'
import { formatModel } from '../lib/modelLabel'

interface Props {
  /** The room's model as the header shows it. */
  current: string | null
  /** Commands to offer, sent back verbatim: from the room's models state, or the bot's picker [[options]]. */
  options: string[]
  /** Still waiting on the bot's picker. */
  loading: boolean
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
 * Drops down from the header's model chip: the chip asks the room's bot for
 * its picker, and the bot's [[options]] land here as a menu.
 */
export default function ModelMenu({ current, options, loading, onPick, onClose }: Props) {
  const currentLabel = current ? formatModel(current).toLowerCase() : null
  // Hermes lists every model, current one included; the agent bot leaves it
  // out, but its list in room state does not. The chip already says which one
  // you're on, so drop it. Agent options carry the exact id; Hermes' carry only
  // a family name ("/sol" for "Sol 5.6").
  const shown = options.filter((option) => {
    const id = /^!model\s+(\S+)$/.exec(option)?.[1]
    if (id) return id !== current
    return !currentLabel || !currentLabel.includes(modelOptionLabel(option).toLowerCase())
  })

  return (
    <>
      <div className="model-menu-backdrop" onClick={onClose} />
      <div className="model-menu glass" role="menu" aria-label="Switch model">
        {loading ? (
          <div className="model-menu-status"><span className="approval-bar-spinner" /></div>
        ) : shown.length === 0 ? (
          <div className="model-menu-status">No other models</div>
        ) : (
          shown.map((option, i) => (
            <button
              key={option}
              type="button"
              role="menuitem"
              className="model-menu-item"
              style={{ '--i': i } as CSSProperties}
              // Same as the pills: a tap must not move focus to or from the composer.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(option)}
            >
              {modelOptionLabel(option)}
            </button>
          ))
        )}
      </div>
    </>
  )
}
