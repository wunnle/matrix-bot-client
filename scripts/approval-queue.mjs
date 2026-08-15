// One approval question per room, with the rest waiting behind it.
//
// Split out of claude-code-bot.mjs so it can be tested without logging into
// Matrix: everything here is bookkeeping, and the two things that touch the
// world — putting a card up, saying a question expired — are passed in.
//
// A second approval used to be denied outright, on the reasoning that Claude is
// blocked inside the hook and cannot ask twice. That holds for one turn, but
// not for a hook that gave up and left its question standing, nor for Codex,
// whose approvals arrive on a socket that keeps running. The denial then
// answered every later call in the room, so one unnoticed prompt made the agent
// look broken until the deadline passed. Waiting costs a pause; denying costs
// the work.

export function createApprovalQueue({ timeoutMs, maxQueued = 5, present, onTimeout }) {
  // roomId -> { id, resolve, timer, toolName }. One question on screen at a
  // time: two cards in a room are ambiguous, because [[Approve]] names no card.
  const pending = new Map()
  // roomId -> [{ id, request, resolve }] waiting their turn.
  const queued = new Map()
  let seq = 0

  // Puts one question on screen and starts its clock. The deadline runs from
  // being asked, not from being queued — otherwise a request could expire while
  // still behind another, having never been shown to anyone.
  function show(roomId, entry) {
    const { id, resolve, request } = entry
    const timer = setTimeout(() => {
      pending.delete(roomId)
      onTimeout?.(roomId, request.toolName)
      resolve({ decision: 'deny', reason: 'Timed out waiting for approval.' })
      next(roomId)
    }, timeoutMs)
    pending.set(roomId, { id, resolve, timer, toolName: request.toolName })
    present(roomId, request, (reason) => release(roomId, id, reason))
  }

  function next(roomId) {
    const queue = queued.get(roomId)
    if (!queue?.length) return
    const entry = queue.shift()
    if (!queue.length) queued.delete(roomId)
    show(roomId, entry)
  }

  function ask(roomId, request) {
    return new Promise((resolve) => {
      const entry = { id: ++seq, request, resolve }
      // The caller can go away before it is ever asked — a hook that aborted, a
      // socket that died. Drop it rather than showing a card nobody awaits.
      request.signal?.addEventListener('abort', () => {
        release(roomId, entry.id, 'Approval client disconnected.')
      }, { once: true })

      if (pending.has(roomId)) {
        const queue = queued.get(roomId) ?? []
        // Past this the room is being asked faster than anyone could answer,
        // and the backlog is more likely a loop than a queue.
        if (queue.length >= maxQueued) {
          resolve({ decision: 'deny', reason: `More than ${maxQueued} approvals are already waiting in this room.` })
          return
        }
        queue.push(entry)
        queued.set(roomId, queue)
        return
      }
      show(roomId, entry)
    })
  }

  // Resolves the question on screen, if any. Returns false when there was
  // nothing pending, so the caller can treat a message as an ordinary prompt.
  function settle(roomId, decision, reason) {
    const current = pending.get(roomId)
    if (!current) return false
    clearTimeout(current.timer)
    pending.delete(roomId)
    current.resolve({ decision, reason })
    // Whoever was behind it has been waiting in silence; ask them now.
    next(roomId)
    return true
  }

  // Cancels one specific request, wherever it is. Identity matters: releasing
  // "the room's pending approval" would settle whichever card happens to be on
  // screen, which is not necessarily the one whose caller went away.
  function release(roomId, id, reason) {
    if (pending.get(roomId)?.id === id) return settle(roomId, 'deny', reason)
    const queue = queued.get(roomId)
    const at = queue?.findIndex((e) => e.id === id) ?? -1
    if (at === -1) return false
    const [entry] = queue.splice(at, 1)
    entry.resolve({ decision: 'deny', reason })
    return true
  }

  // Denies everything waiting without asking. For the commands that abandon the
  // turn: what was queued belonged to work that is no longer running.
  function dropQueued(roomId, reason) {
    const queue = queued.get(roomId) ?? []
    queued.delete(roomId)
    for (const entry of queue) entry.resolve({ decision: 'deny', reason })
    return queue.length
  }

  return { ask, settle, release, dropQueued }
}
