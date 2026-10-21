// Subagent cards: one room message per subagent, kept current with m.replace
// edits as the provider reports it moving (see createSubagentTracker in
// providers/claude.mjs). Construct folds the edits into the first event and
// draws `com.construct.subagent` as a card; other clients see the body line.

const STATUS_WORD = { running: 'working', completed: 'done', failed: 'failed', stopped: 'stopped' }

// The plain-text stand-in, for clients that don't know the card.
export function subagentBody(card) {
  const type = card.agentType ? ` (${card.agentType})` : ''
  return `🤖 agent: ${card.description}${type} — ${STATUS_WORD[card.status] ?? card.status}`
}

export function subagentContent(card) {
  return {
    msgtype: 'm.text',
    body: subagentBody(card),
    'com.construct.subagent': card,
    // Never pushes or counts as unread, like a tool line.
    'com.construct.machine': { kind: 'notification', source: 'claude-subagent' },
  }
}

// Posts a card's first snapshot and edits it with later ones, at most one edit
// per `throttleMs` per card. A finished card is sent at once, so the final
// state never waits on a timer that a bot restart could lose. Sends for one card
// are chained, so an edit can't be sent before the event it edits exists.
//
// `send(content)` resolves to an event id; `edit(eventId, content)` sends the
// replacement. Failures are reported to `onError` and never thrown: a card that
// can't be posted must not sink the turn.
export function createCardPoster({ send, edit, throttleMs = 2500, onError = () => {}, now = Date.now } = {}) {
  const cards = new Map()

  const flush = (state) => {
    clearTimeout(state.timer)
    state.timer = null
    const card = state.pending
    if (!card) return state.chain
    state.pending = null
    state.lastSent = now()
    state.chain = state.chain.then(async () => {
      const content = subagentContent(card)
      if (state.eventId) await edit(state.eventId, content)
      else if (!state.failed) state.eventId = await send(content)
    }).catch((e) => {
      // Without its first event a card has nothing to edit; stop trying.
      if (!state.eventId) state.failed = true
      onError(e)
    })
    return state.chain
  }

  const update = (card) => {
    let state = cards.get(card.id)
    if (!state) {
      state = { eventId: null, chain: Promise.resolve(), pending: null, timer: null, lastSent: null, failed: false }
      cards.set(card.id, state)
    }
    state.pending = card
    const wait = state.lastSent === null ? 0 : state.lastSent + throttleMs - now()
    if (card.status !== 'running' || wait <= 0) return flush(state)
    if (!state.timer) state.timer = setTimeout(() => flush(state), wait)
    return state.chain
  }

  // Sends whatever is still held back, for when the turn is over.
  const drain = () => Promise.all([...cards.values()].map(flush))

  return { update, drain }
}
