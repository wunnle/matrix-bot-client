// Turning what the owner typed into a title, and filling a title in from TMDB.
//
// Two sources, each for what it is good at:
//   Cinemeta (Stremio's catalogue)  name search that returns IMDb ids, no key
//   TMDB                            poster, seasons, next episode, and where to
//                                   watch in a region — keyed by the IMDb id
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const CINEMETA = 'https://v3-cinemeta.strem.io'
const TMDB = 'https://api.themoviedb.org/3'
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w342'
const CONFIG_DIR = process.env.WATCHLIST_CONFIG ?? path.join(os.homedir(), '.config', 'watchlist')

/** An IMDb link or a bare `tt…` id anywhere in the text, else a title to search. */
export function parseInput(text) {
  const id = /\btt\d{5,}\b/.exec(text)?.[0]
  if (id) return { imdbId: id }
  const query = text.trim().replace(/\s+/g, ' ')
  return query ? { query } : null
}

// "X-Men '97" and "x men 97" are the same title to a person typing it.
const normalize = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim()

// How far ahead the most popular of several same-named titles must be to be
// taken without asking. "Severance" the Apple show vs the 2006 film is ~20×.
const DOMINANT = 3

/**
 * Decide between adding at once and asking. One exact title match, or a single
 * result, is added. Several exact matches are settled by TMDB popularity when
 * one clearly dominates (`others` then holds the runners-up, so the reply can
 * offer a swap); otherwise, and for fuzzy matches, it's a choice.
 *
 * @param {{id, kind, title, year, popularity?}[]} candidates in source order
 * @returns {{pick, others?} | {choices} | {none: true}}
 */
export function pickCandidate(query, candidates) {
  if (!candidates.length) return { none: true }
  if (candidates.length === 1) return { pick: candidates[0] }
  const exact = candidates.filter((c) => normalize(c.title) === normalize(query))
  if (exact.length === 1) return { pick: exact[0] }
  if (exact.length > 1 && exact.every((c) => Number.isFinite(c.popularity))) {
    const [top, ...rest] = [...exact].sort((a, b) => b.popularity - a.popularity)
    if (top.popularity >= DOMINANT * rest[0].popularity) return { pick: top, others: rest.slice(0, 3) }
  }
  const pool = exact.length ? exact : candidates
  // Newest first among equals: the remake you just heard about, not the 1970s original.
  return { choices: [...pool].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).slice(0, 4) }
}

/** Whether pickCandidate would want popularity to settle these. */
export function needsPopularity(query, candidates) {
  return candidates.filter((c) => normalize(c.title) === normalize(query)).length > 1
}

/** The button text for a choice. Unique enough to map a tap back to its id. */
export function choiceLabel(c) {
  return `${c.title} (${[c.year, c.kind === 'movie' ? 'film' : 'series'].filter(Boolean).join(', ')})`
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  return res.json()
}

export async function searchCinemeta(query) {
  const out = []
  for (const kind of ['series', 'movie']) {
    let data
    try {
      data = await getJson(`${CINEMETA}/catalog/${kind}/top/search=${encodeURIComponent(query)}.json`)
    } catch {
      continue
    }
    for (const m of data.metas ?? []) {
      const id = m.imdb_id ?? m.id
      if (!/^tt\d+$/.test(id ?? '')) continue
      out.push({ id, kind, title: m.name, year: parseInt(m.releaseInfo, 10) || null, poster: m.poster ?? null })
    }
  }
  return out
}

function tmdbToken() {
  const env = fs.readFileSync(path.join(CONFIG_DIR, 'env'), 'utf8')
  const token = /^TMDB_API_KEY=(.*)$/m.exec(env)?.[1]?.trim()
  if (!token) throw new Error('no TMDB_API_KEY in ~/.config/watchlist/env')
  return token
}

function subscriptions() {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'subscriptions.json'), 'utf8'))
}

const tmdb = (p) => getJson(`${TMDB}${p}`, { Authorization: `Bearer ${tmdbToken()}` })

/**
 * Everything TMDB knows that the list shows, for one IMDb id. Null when TMDB
 * has never heard of it — the caller keeps whatever it already had.
 */
export async function enrich(imdbId) {
  const found = await tmdb(`/find/${imdbId}?external_source=imdb_id`)
  const tv = found.tv_results?.[0]
  const movie = found.movie_results?.[0]
  const hit = tv ?? movie
  if (!hit) return null
  const kind = tv ? 'series' : 'movie'
  const base = `/${tv ? 'tv' : 'movie'}/${hit.id}`
  const [detail, providers] = await Promise.all([tmdb(base), tmdb(`${base}/watch/providers`)])

  // Flatrate only: rent and buy are listed by the same stores, and "you could
  // pay extra for it" is not "it's on your subscription".
  const { region, subscriptions: subs } = subscriptions()
  const flat = providers.results?.[region]?.flatrate ?? []
  const where = Object.entries(subs)
    .filter(([, s]) => flat.some((f) => s.tmdb_ids.includes(f.provider_id)))
    .map(([key]) => key)

  const date = tv ? detail.first_air_date : detail.release_date
  const ne = detail.next_episode_to_air
  return {
    tmdbId: hit.id,
    kind,
    title: tv ? detail.name : detail.title,
    year: parseInt(date, 10) || null,
    poster: detail.poster_path ? `${TMDB_IMAGE}${detail.poster_path}` : null,
    providers: where,
    next: ne ? { season: ne.season_number, episode: ne.episode_number, airDate: ne.air_date } : null,
    refreshedAt: Date.now(),
  }
}

/**
 * TMDB's popularity for each candidate whose title matches the query exactly
 * (0 when TMDB doesn't know it). Only those — they are the ones that tie.
 */
export async function withPopularity(query, candidates) {
  return Promise.all(candidates.map(async (c) => {
    if (normalize(c.title) !== normalize(query)) return c
    try {
      const found = await tmdb(`/find/${c.id}?external_source=imdb_id`)
      const hit = (c.kind === 'movie' ? found.movie_results : found.tv_results)?.[0]
        ?? found.tv_results?.[0] ?? found.movie_results?.[0]
      return { ...c, popularity: hit?.popularity ?? 0 }
    } catch {
      return c
    }
  }))
}

/** A title Cinemeta knows by id, for when TMDB doesn't. */
export async function cinemetaMeta(imdbId) {
  for (const kind of ['series', 'movie']) {
    try {
      const { meta } = await getJson(`${CINEMETA}/meta/${kind}/${imdbId}.json`)
      if (meta?.name) return { id: imdbId, kind, title: meta.name, year: parseInt(meta.releaseInfo ?? meta.year, 10) || null, poster: meta.poster ?? null }
    } catch {
      // try the other kind
    }
  }
  return null
}
