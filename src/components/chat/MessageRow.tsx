import React, { memo } from 'react'
import type { Message, ConstructApproval, ConstructForm } from '../../types'
import type { AgentRun } from '../../hooks/useAgentActivity'
import { AgentActivityBar } from '../AgentActivityBar'
import { parseActions, stripActionMarkersInRichHtml } from '../../lib/actions'
import { parseToolProgressMessage } from '../../lib/toolProgress'
import { formatDate, formatSentAt } from '../../lib/chatFormat'
import { ArtifactBlock, BrowserBlock, LocationLink, SubagentBlock, ThreadBlock } from './MessageCards'
import { ChoiceList, FormCard } from './MessageChoices'

export interface MessageRowProps {
  msg: Message
  userId: string
  /** Row shape, all precomputed by the parent from neighbouring messages. */
  showDateDivider: boolean
  senderSwitch: boolean
  showPeerSender: boolean
  /** Rooms with several agents: 'first' row of an agent's run shows its avatar and
   *  name, 'spacer' keeps the column; 'none' everywhere else. */
  avatar: 'none' | 'first' | 'spacer'
  avatarUrl?: string
  isTool: boolean
  prevIsTool: boolean
  nextIsTool: boolean
  canPin: boolean
  /** Tool-group summary, for the one row that starts a group. */
  toolSummary: string
  toolLive: boolean
  imageUrl?: string
  fileUrl?: string
  isPinned: boolean
  pinInFlight: boolean
  /** "Select text" from the action sheet re-enabled selection on this row. */
  selecting: boolean
  /** Only on the row that starts the tool group the run is adding to: the run,
   *  so the chip can show the step in flight under its summary. */
  liveRun: AgentRun | null
  botTyping: boolean
  onLiveChange: (live: boolean) => void
  onOpenToolDialog: (eventId: string) => void
  onOpenLightbox: (url: string, alt: string) => void
  onOpenApproval: (approval: ConstructApproval) => void
  /** The picks already sent for this row's form, newline-joined; undefined while it is open. */
  formAnswer?: string
  onSubmitForm: (eventId: string, form: ConstructForm, picked: string[]) => void
  /** Set when this row's [[…]] buttons show as a lettered list: whether it still takes a pick. */
  choiceOpen?: boolean
  /** The option the reply after it picked, for a closed list. */
  choicePicked?: string
  onPickChoice: (label: string) => void
  onRichClick: (e: React.MouseEvent<HTMLDivElement>) => void
  onRichPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onReact: (eventId: string, emoji: string) => void
  onCopy: (body: string) => void
  onTogglePin: (eventId: string) => void
  onInspect: (eventId: string) => void
}

/**
 * One row of the timeline.
 *
 * Memoised on purpose: the bot sends a tool-progress line every few seconds
 * during a run, and without this every arrival re-rendered every row in the
 * room — which rebuilds their code blocks and kills a scrollbar drag in
 * progress. Props are therefore primitives and stable callbacks only; anything
 * derived from neighbouring messages is computed by the parent so this compares
 * cheaply.
 */
function MessageRowInner({
  msg,
  userId,
  showDateDivider,
  senderSwitch,
  showPeerSender,
  avatar,
  avatarUrl,
  isTool,
  prevIsTool,
  nextIsTool,
  canPin,
  toolSummary,
  toolLive,
  imageUrl,
  fileUrl,
  isPinned,
  pinInFlight,
  selecting,
  liveRun,
  botTyping,
  onLiveChange,
  onOpenToolDialog,
  onOpenLightbox,
  onOpenApproval,
  formAnswer,
  onSubmitForm,
  choiceOpen,
  choicePicked,
  onPickChoice,
  onRichClick,
  onRichPointerDown,
  onReact,
  onCopy,
  onTogglePin,
  onInspect,
}: MessageRowProps) {
  return (
              <div
                data-event-id={msg.eventId}
                className={isTool ? `tool-progress-wrap${prevIsTool ? ' tool-progress-wrap-cont' : ''}${nextIsTool ? ' tool-progress-wrap-open' : ''}` : undefined}
              >
                {showDateDivider && (
                  <div className="date-divider">
                    <span>{formatDate(msg.timestamp)}</span>
                  </div>
                )}
                <div className={`message ${msg.isOwnMessage ? 'own' : 'other'}${msg.isPeerMessage ? ' peer' : ''}${senderSwitch ? ' sender-switch' : ''}${selecting ? ' message--selecting' : ''}`}>
                  {avatar !== 'none' && (
                    <div className="msg-agent-avatar" aria-hidden="true">
                      {avatar === 'first' && (avatarUrl
                        ? <img src={avatarUrl} alt="" />
                        : <span>{(msg.authorName || msg.sender.replace(/^@/, '')).slice(0, 1).toUpperCase()}</span>)}
                    </div>
                  )}
                  <div className="message-body">
                    {avatar === 'first' && msg.authorName && (
                      <div className="agent-sender">{msg.authorName}</div>
                    )}
                    {/* Another member's request, not the bot's own voice — say whose. */}
                    {msg.isPeerMessage && showPeerSender && (
                      <div className="peer-sender">{msg.senderName}</div>
                    )}
                    {msg.isOwnMessage ? (
                      <>
                        <div className="message-pin-surface message-pin-surface--own">
                          <div className={`bubble ${msg.isDecryptionFailure ? 'bubble-failed' : ''} ${imageUrl ? (msg.caption ? 'bubble-image-captioned' : 'bubble-image') : ''} ${msg.source === 'voice' ? 'bubble-voice' : ''}`}>
                            {msg.source === 'voice' && (
                              <span className="material-icons bubble-voice-icon" title="Voice input">mic</span>
                            )}
                            {imageUrl
                              ? <img src={imageUrl} alt={msg.body || 'image'} className="msg-image" onClick={e => { e.stopPropagation(); onOpenLightbox(imageUrl, msg.body || 'image') }} />
                              : msg.location
                              ? <LocationLink location={msg.location} />
                              : fileUrl
                                ? <a href={fileUrl} download={msg.fileName} className="msg-file" target="_blank" rel="noreferrer"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</a>
                                : msg.fileMxc && !fileUrl
                                  ? <span className="msg-file msg-file-loading"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</span>
                                  : msg.body}
                            {/* Until the image loads, the body fallback above is already the caption. */}
                            {msg.caption && (imageUrl || msg.fileMxc) && <div className="msg-caption">{msg.caption}</div>}
                          </div>
                        </div>
                        <div className={`msg-status ${msg.isRead ? 'msg-status-read' : ''}`}>
                          {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                            <span className="reaction-bar reaction-bar--own-inline">
                              {Object.entries(msg.reactions).map(([emoji, senders]) => (
                                <span key={emoji} className="reaction-pill--own">
                                  {emoji}{senders.length > 1 && <span className="reaction-count">{senders.length}</span>}
                                </span>
                              ))}
                            </span>
                          )}
                          <span className="material-icons">{msg.isRead ? 'done_all' : 'done'}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        {(() => {
                          if (isTool) {
                            const isGroupStart = !prevIsTool

                            // Non-start messages in any group are hidden — summary shown at group start
                            if (!isGroupStart) return null

                            // All groups show as a summary chip (live group updates in real time)
                            const chip = (
                              <div
                                className={`tool-progress tool-progress-collapsed${toolLive ? ' tool-progress-live' : ''}`}
                                onClick={() => onOpenToolDialog(msg.eventId)}
                              >
                                <span className="tool-progress-tool">{toolSummary}</span>
                                {toolLive && <span className="tool-progress-live-dot" />}
                              </div>
                            )
                            // While the run is on, the group is just what it's
                            // doing now ("Searching AppDelegate.swift"), changing
                            // as it moves on; the summary of what it did takes
                            // over once it's done — or if the run goes quiet.
                            if (!liveRun) return chip
                            return (
                              <div className="tool-progress-now" onClick={() => onOpenToolDialog(msg.eventId)}>
                                <AgentActivityBar run={liveRun} botTyping={botTyping} onLiveChange={onLiveChange} fallback={chip} />
                              </div>
                            )

                            // dead code kept for type-checker
                            const lines = parseToolProgressMessage(msg.body, msg)
                            return (
                              <div
                                className={`message-pin-surface message-pin-surface--tool tool-progress${prevIsTool ? ' tool-progress-cont' : ''}${nextIsTool ? ' tool-progress-open' : ''}`}

                              >
                                {lines.map((l, idx) => (
                                  <div key={idx} className="tool-progress-line">
                                    <span className="tool-progress-emoji">{l.emoji}</span>
                                    <span className="tool-progress-tool">{l.tool}</span>
                                    {l.content !== undefined && (
                                      <span className="tool-progress-content">{l.content}</span>
                                    )}
                                    {l.repeat !== undefined && (
                                      <span className="tool-progress-repeat">×{l.repeat}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )
                          }
                          const { text, actions } = parseActions(msg.body)
                          const cleanHtml = msg.formattedBody
                            ? stripActionMarkersInRichHtml(msg.formattedBody).trim()
                            : undefined
                          return (
                            <>
                              <div className="message-pin-surface">
                                <div
                                  className={`bot-text ${cleanHtml ? 'bot-text-rich' : ''} ${msg.isDecryptionFailure ? 'bubble-failed' : ''} ${msg.machine && !msg.subagent && !msg.artifact && !msg.browser ? 'bot-text-machine' : ''}${msg.subagent || msg.artifact || msg.browser ? ' bot-text-card' : ''}`}
                                  onClick={cleanHtml ? onRichClick : undefined}
                                  onPointerDown={cleanHtml ? onRichPointerDown : undefined}
                                  title={msg.machine?.source ? `Machine message from ${msg.machine.source}` : undefined}
                                >
                                  {msg.subagent
                                    ? <SubagentBlock card={msg.subagent} />
                                    : msg.artifact
                                    ? <ArtifactBlock artifact={msg.artifact} />
                                    : msg.browser
                                    ? <BrowserBlock page={msg.browser} />
                                    : msg.threads
                                    ? <div className="msg-threads">{msg.threads.map((t, i) => <ThreadBlock key={i} thread={t} />)}</div>
                                    : msg.cards
                                    ? <div className="msg-cards">
                                        {msg.cards.map((card, ci) => {
                                          const hasActions = card.actions && card.actions.length > 0
                                          const hasFooter = hasActions || !!card.price
                                          const isLinkCard = !hasFooter && !!card.url
                                          const inner = (
                                            <>
                                              {card.image && <img className="msg-card-image" src={card.image} alt="" loading="lazy" />}
                                              <div className="msg-card-body">
                                                <div className="msg-card-title">{card.title}</div>
                                                {card.subtitle && <div className="msg-card-subtitle">{card.subtitle}</div>}
                                                {card.description && <div className="msg-card-description">{card.description}</div>}
                                                {card.fields && card.fields.length > 0 && (
                                                  <dl className="msg-card-fields">
                                                    {card.fields.map((f, fi) => (
                                                      <div key={fi} className="msg-card-field">
                                                        <dt>{f.label}</dt>
                                                        <dd>{f.value}</dd>
                                                      </div>
                                                    ))}
                                                  </dl>
                                                )}
                                              </div>
                                              {hasFooter && (
                                                <div className="msg-card-footer">
                                                  {card.price && <span className="msg-card-price">{card.price}</span>}
                                                  {hasActions && (
                                                    <div className="msg-card-actions">
                                                      {card.actions!.map((a, ai) => (
                                                        <a key={ai} className="msg-card-action" href={a.url} target="_blank" rel="noopener noreferrer">{a.label}</a>
                                                      ))}
                                                    </div>
                                                  )}
                                                </div>
                                              )}
                                            </>
                                          )
                                          return isLinkCard
                                            ? <a key={ci} className="msg-card msg-card-link" href={card.url} target="_blank" rel="noopener noreferrer">{inner}</a>
                                            : <div key={ci} className="msg-card">{inner}</div>
                                        })}
                                      </div>
                                    : imageUrl
                                    ? <img src={imageUrl} alt={msg.body || 'image'} className="msg-image" onClick={e => { e.stopPropagation(); onOpenLightbox(imageUrl, msg.body || 'image') }} />
                                    : msg.location
                                    ? <LocationLink location={msg.location} />
                                    : fileUrl
                                      ? <a href={fileUrl} download={msg.fileName} className="msg-file" target="_blank" rel="noreferrer"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</a>
                                      : msg.fileMxc && !fileUrl
                                        ? <span className="msg-file msg-file-loading"><span className="material-icons msg-file-icon">insert_drive_file</span>{msg.fileName}</span>
                                        : cleanHtml
                                          ? <div className="rich-html" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
                                          : text}
                                  {msg.caption && !msg.cards && !msg.threads && (imageUrl || msg.fileMxc) && <div className="msg-caption">{msg.caption}</div>}
                                  {msg.places && (
                                    <div className="msg-places">
                                      {msg.places.map((place, pi) => <LocationLink key={pi} location={place} />)}
                                    </div>
                                  )}
                                  {msg.form && (
                                    <FormCard
                                      form={msg.form}
                                      answer={formAnswer}
                                      onSubmit={(picked) => onSubmitForm(msg.eventId, msg.form!, picked)}
                                    />
                                  )}
                                  {choiceOpen !== undefined && (
                                    <ChoiceList
                                      actions={actions}
                                      open={choiceOpen}
                                      picked={choicePicked}
                                      onPick={onPickChoice}
                                    />
                                  )}
                                </div>
                                {msg.approval && (
                                  <button
                                    className="approval-full-btn"
                                    onClick={(e) => { e.stopPropagation(); onOpenApproval(msg.approval!) }}
                                  >
                                    <span className="material-icons approval-full-icon">unfold_more</span>
                                    View all {msg.approval.lines} lines
                                  </button>
                                )}
                              </div>
                              {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                                <div className="reaction-bar">
                                  {Object.entries(msg.reactions).map(([emoji, senders]) => (
                                    <button
                                      key={emoji}
                                      className={`reaction-btn${senders.includes(userId) ? ' reaction-btn--active' : ''}`}
                                      onClick={() => onReact(msg.eventId, emoji)}
                                    >
                                      {emoji}<span className="reaction-count">{senders.length}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </>
                    )}
                    {canPin && (
                      // Always rendered, only hidden: reserving the row's height
                      // keeps messages from jumping on hover, and the reserved
                      // space doubles as the gap between messages.
                      // On touch it never shows: a long-press opens the same
                      // actions in a sheet (see handleMessagesPointerDown).
                      <div className="message-meta">
                        <span className="message-meta-actions">
                          <button
                            type="button"
                            className="message-meta-btn"
                            aria-label="Copy message"
                            onClick={() => onCopy(msg.body)}
                          >
                            <span className="material-symbols-outlined">content_copy</span>
                          </button>
                          <button
                            type="button"
                            className={`message-meta-btn${isPinned ? ' message-meta-btn--on' : ''}`}
                            aria-label={isPinned ? 'Unpin message' : 'Pin message'}
                            disabled={pinInFlight}
                            onClick={() => { onTogglePin(msg.eventId) }}
                          >
                            <span className="material-symbols-outlined">keep</span>
                          </button>
                          <button
                            type="button"
                            className="message-meta-btn"
                            aria-label="Inspect event"
                            onClick={() => onInspect(msg.eventId)}
                          >
                            <span className="material-symbols-outlined">data_object</span>
                          </button>
                        </span>
                        <span className="message-meta-info">
                          {/* Own messages: the bubble's side already says who
                              sent it, so only the time is worth showing. */}
                          {msg.isOwnMessage ? '' : <>{msg.authorName}{msg.authorName ? ' · ' : ''}</>}{formatSentAt(msg.timestamp)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
  )
}

export const MessageRow = memo(MessageRowInner)
