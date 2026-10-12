// The watchlist itself: one JSON file for the current list, plus an
// append-only JSONL history of everything that happened to it.
//
// The history is kept from the first day even though nothing reads it yet —
// the read-only log page (BEN-307) is built last, and a log that only starts
// when the page does would be empty.
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * @typedef {object} Item
 * @property {string} id         IMDb id (`tt…`) — the one key every source agrees on
 * @property {'series'|'movie'} kind
 * @property {string} title
 * @property {number|null} year
 * @property {string|null} poster
 * @property {number} addedAt    epoch ms
 * @property {number|null} watchedAt
 */

export function createStore(dir, { now = Date.now } = {}) {
  const listFile = path.join(dir, 'watchlist.json')
  const historyFile = path.join(dir, 'history.jsonl')
  fs.mkdirSync(dir, { recursive: true })

  /** @type {Item[]} */
  let items = []
  try { items = JSON.parse(fs.readFileSync(listFile, 'utf8')).items ?? [] } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  // Write-then-rename, so a crash mid-write leaves the previous list rather
  // than a truncated one.
  function save() {
    const tmp = `${listFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2))
    fs.renameSync(tmp, listFile)
  }

  function record(action, item, extra = {}) {
    const entry = { at: now(), action, id: item.id, title: item.title, ...extra }
    fs.appendFileSync(historyFile, JSON.stringify(entry) + '\n')
  }

  const find = (id) => items.find((i) => i.id === id)

  return {
    list: () => items.map((i) => ({ ...i })),
    get: (id) => { const i = find(id); return i ? { ...i } : null },

    /** @returns {{item: Item, added: boolean}} added is false for a duplicate */
    add({ id, kind, title, year = null, poster = null }) {
      if (!/^tt\d+$/.test(id)) throw new Error(`not an IMDb id: ${id}`)
      const existing = find(id)
      if (existing) return { item: { ...existing }, added: false }
      const item = { id, kind, title, year, poster, addedAt: now(), watchedAt: null }
      items.unshift(item)
      save()
      record('added', item)
      return { item: { ...item }, added: true }
    },

    setWatched(id, watched) {
      const item = find(id)
      if (!item) throw new Error(`not on the watchlist: ${id}`)
      if (Boolean(item.watchedAt) === watched) return { ...item }
      item.watchedAt = watched ? now() : null
      save()
      record(watched ? 'watched' : 'unwatched', item)
      return { ...item }
    },

    remove(id) {
      const index = items.findIndex((i) => i.id === id)
      if (index === -1) throw new Error(`not on the watchlist: ${id}`)
      const [item] = items.splice(index, 1)
      save()
      record('removed', item)
      return item
    },

    /** Playing changes nothing in the list, but it is the most useful line in the log. */
    played(id, extra) {
      const item = find(id)
      if (!item) throw new Error(`not on the watchlist: ${id}`)
      record('played', item, extra)
    },

    history() {
      try {
        return fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      } catch (err) {
        if (err.code === 'ENOENT') return []
        throw err
      }
    },
  }
}
