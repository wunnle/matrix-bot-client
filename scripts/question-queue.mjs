// A small per-room FIFO for questions asked by a running provider turn.
// Unlike ordinary messages, an answer must reach the blocked turn immediately.
export function createQuestionQueue({ timeoutMs, present, onTimeout = () => {} }) {
  const rooms = new Map()

  function show(roomId) {
    const queue = rooms.get(roomId)
    const current = queue?.[0]
    if (!current || current.shown) return
    current.shown = true
    current.timer = setTimeout(() => {
      if (rooms.get(roomId)?.[0] !== current) return
      queue.shift()
      current.reject(new Error('Question timed out.'))
      onTimeout(roomId, current.question)
      if (!queue.length) rooms.delete(roomId)
      else show(roomId)
    }, timeoutMs)
    present(roomId, current.question, (reason) => abandon(roomId, current, reason))
  }

  function abandon(roomId, entry, reason) {
    const queue = rooms.get(roomId)
    const index = queue?.indexOf(entry) ?? -1
    if (index === -1) return false
    queue.splice(index, 1)
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
    if (!queue.length) rooms.delete(roomId)
    else if (index === 0) show(roomId)
    return true
  }

  function ask(roomId, question) {
    return new Promise((resolve, reject) => {
      const queue = rooms.get(roomId) ?? []
      queue.push({ question, resolve, reject, shown: false, timer: null })
      rooms.set(roomId, queue)
      show(roomId)
    })
  }

  function answer(roomId, text) {
    const queue = rooms.get(roomId)
    const current = queue?.[0]
    if (!current) return false
    const raw = String(text).trim()
    const option = current.question.options?.find((value) => value.toLowerCase() === raw.toLowerCase())
    if (!option && !current.question.allowOther) return false
    if (!option && !raw) return false
    queue.shift()
    clearTimeout(current.timer)
    current.resolve(option ?? raw)
    if (!queue.length) rooms.delete(roomId)
    else show(roomId)
    return true
  }

  function drop(roomId, reason) {
    const queue = rooms.get(roomId)
    if (!queue?.length) return false
    rooms.delete(roomId)
    for (const entry of queue) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    return true
  }

  return { ask, answer, drop, has: (roomId) => Boolean(rooms.get(roomId)?.length) }
}
