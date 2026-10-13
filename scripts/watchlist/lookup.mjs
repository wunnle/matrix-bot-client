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

/**
 * Corrections for where TMDB's region data is wrong, by IMDb id:
 * `{"tt…": {"notOn": ["hbomax"]}}`. Read on every lookup, so an edit applies
 * at the next refresh without a restart. Missing file means no corrections.
 */
function overrides() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'overrides.json'), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

const tmdb = (p) => getJson(`${TMDB}${p}`, { Authorization: `Bearer ${tmdbToken()}` })

// What's in cinemas in the region: TMDB's now-playing list, a few pages, shared
// by a whole refresh run rather than fetched per film.
const NOW_PLAYING_TTL_MS = 6 * 60 * 60 * 1000
let nowPlaying = { region: null, at: 0, ids: new Set() }

async function nowPlayingIds(region) {
  if (nowPlaying.region === region && Date.now() - nowPlaying.at < NOW_PLAYING_TTL_MS) return nowPlaying.ids
  const ids = new Set()
  for (let page = 1, pages = 1; page <= pages && page <= 10; page++) {
    const data = await tmdb(`/movie/now_playing?region=${region}&page=${page}`)
    pages = data.total_pages ?? 1
    for (const m of data.results ?? []) ids.add(m.id)
  }
  nowPlaying = { region, at: Date.now(), ids }
  return ids
}

/** Cut at a word boundary with an ellipsis, when longer than `max`. */
export function truncate(text, max) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max).trimEnd()}…`
}

// TMDB release types.
const LIMITED = 2, THEATRICAL = 3, DIGITAL = 4
// Where to look when the region has no entry: most films list the US.
const FALLBACK_REGION = 'US'

/**
 * What a film's per-country release dates say, from TMDB's `release_dates`
 * results: when it opens in the region's cinemas, when it is out digitally
 * (region first, else the US, labelled so the UI can say which), and its age
 * rating. Pure, so it can be tested without TMDB.
 */
export function releaseInfo(results = [], region) {
  const datesIn = (r) => results.find((x) => x.iso_3166_1 === r)?.release_dates ?? []
  const earliest = (dates, types) =>
    dates.filter((d) => types.includes(d.type)).map((d) => d.release_date.slice(0, 10)).sort()[0] ?? null
  const local = datesIn(region)
  const fallback = datesIn(FALLBACK_REGION)
  const digitalHere = earliest(local, [DIGITAL])
  const digitalThere = earliest(fallback, [DIGITAL])
  const cert = (dates) => dates.map((d) => d.certification).find(Boolean) ?? null
  return {
    cinemaOpens: earliest(local, [LIMITED, THEATRICAL]),
    digital: digitalHere ? { date: digitalHere, region } : digitalThere ? { date: digitalThere, region: FALLBACK_REGION } : null,
    ageRating: cert(local) ?? cert(fallback),
  }
}

/** The YouTube key of a title's trailer: an official one if there is one. */
export function trailerKey(videos = []) {
  const yt = videos.filter((v) => v.site === 'YouTube' && v.type === 'Trailer')
  return (yt.find((v) => v.official) ?? yt[0])?.key ?? null
}

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
  // One call for the details and everything hung off them.
  const extra = tv ? 'credits,videos,content_ratings' : 'credits,videos,release_dates'
  const [detail, providers] = await Promise.all([tmdb(`${base}?append_to_response=${extra}`), tmdb(`${base}/watch/providers`)])

  // Flatrate only: rent and buy are listed by the same stores, and "you could
  // pay extra for it" is not "it's on your subscription".
  const { region, subscriptions: subs } = subscriptions()
  const flat = providers.results?.[region]?.flatrate ?? []
  const notOn = overrides()[imdbId]?.notOn ?? []
  const where = Object.entries(subs)
    .filter(([key, s]) => !notOn.includes(key) && flat.some((f) => s.tmdb_ids.includes(f.provider_id)))
    .map(([key]) => key)

  const date = tv ? detail.first_air_date : detail.release_date
  const ne = detail.next_episode_to_air
  const le = detail.last_episode_to_air
  const [playing, imdbRating] = await Promise.all([
    tv ? null : nowPlayingIds(region).catch(() => new Set()),
    imdbScore(imdbId, kind),
  ])

  const release = tv ? null : releaseInfo(detail.release_dates?.results, region)
  const showRating = (r) => detail.content_ratings?.results?.find((x) => x.iso_3166_1 === r)?.rating || null
  const cinemaNow = !tv && playing.has(hit.id)
  const runtime = tv ? (detail.episode_run_time?.[0] ?? le?.runtime ?? null) : (detail.runtime || null)
  const people = tv
    ? (detail.created_by ?? []).map((p) => p.name)
    : (detail.credits?.crew ?? []).filter((p) => p.job === 'Director').map((p) => p.name)

  return {
    tmdbId: hit.id,
    kind,
    title: tv ? detail.name : detail.title,
    year: parseInt(date, 10) || null,
    poster: detail.poster_path ? `${TMDB_IMAGE}${detail.poster_path}` : null,
    providers: where,
    next: ne ? { season: ne.season_number, episode: ne.episode_number, airDate: ne.air_date } : null,
    lastAired: le?.air_date ? { season: le.season_number, episode: le.episode_number, airDate: le.air_date } : null,
    showStatus: tv ? showStatus(detail.status) : null,
    cinema: release?.cinemaOpens || cinemaNow ? { opens: release?.cinemaOpens ?? null, now: cinemaNow } : null,
    imdbRating,
    releaseDate: date || null,
    digital: release?.digital ?? null,
    // Minutes: the film, or one episode.
    runtime,
    genres: (detail.genres ?? []).map((g) => g.name),
    // Trimmed: the whole list rides in one room-state event, capped at 64 KiB.
    overview: detail.overview ? truncate(detail.overview, 320) : null,
    // Directors for a film, creators for a show.
    people: people.slice(0, 2),
    cast: (detail.credits?.cast ?? []).slice(0, 3).map((p) => p.name),
    ageRating: tv ? (showRating(region) ?? showRating(FALLBACK_REGION)) : release.ageRating,
    trailer: trailerKey(detail.videos?.results),
    seasons: tv ? detail.number_of_seasons ?? null : null,
    refreshedAt: Date.now(),
  }
}

/**
 * Whether a show is coming back, from TMDB's status. `next` only exists once an
 * episode has a date, so without this "renewed, no date yet" and "over for
 * good" look the same.
 */
export function showStatus(status) {
  switch (status) {
    case 'Returning Series': return 'returning'
    case 'In Production': case 'Planned': case 'Pilot': return 'in-production'
    case 'Ended': return 'ended'
    case 'Canceled': return 'canceled'
    default: return null
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

/**
 * The episode that brings a watched show back, or null. It must have aired on
 * a later day than the one you marked the show watched — an episode out the
 * same day you finished it is assumed seen. Days are Istanbul days, which is
 * close enough to TMDB's air dates for this.
 *
 * @param {{kind, watchedAt, lastAired?}} item  after the refresh
 */
export function episodeSinceWatched(item, today = new Date()) {
  if (item.kind !== 'series' || !item.watchedAt || !item.lastAired?.airDate) return null
  const day = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' })
  const aired = item.lastAired.airDate
  return aired > day(item.watchedAt) && aired <= day(today) ? item.lastAired : null
}

/**
 * IMDb's own rating, which TMDB doesn't carry (its vote_average is TMDB's).
 * Cinemeta mirrors it keylessly. Null for titles too new to have one.
 *
 * A string ("7.8"), not a number: Matrix events are canonical JSON, which
 * has no floats — a 7.8 in room state is rejected with M_BAD_JSON.
 */
async function imdbScore(imdbId, kind) {
  try {
    const { meta } = await getJson(`${CINEMETA}/meta/${kind}/${imdbId}.json`)
    const score = parseFloat(meta?.imdbRating)
    return Number.isFinite(score) && score > 0 ? score.toFixed(1) : null
  } catch {
    return null
  }
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
