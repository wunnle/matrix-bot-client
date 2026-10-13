import assert from 'node:assert/strict'
import { choiceLabel, episodeSinceWatched, needsPopularity, parseInput, pickCandidate, releaseInfo, trailerKey, truncate } from './watchlist/lookup.mjs'

// Links in every shape IMDb hands out, and a bare id.
assert.deepEqual(parseInput('https://www.imdb.com/title/tt11280740/'), { imdbId: 'tt11280740' })
assert.deepEqual(parseInput('https://m.imdb.com/title/tt0903747/?ref_=nv_sr_srsg_0'), { imdbId: 'tt0903747' })
assert.deepEqual(parseInput('add tt32603995 please'), { imdbId: 'tt32603995' })
assert.deepEqual(parseInput('  The   Bear '), { query: 'The Bear' })
assert.equal(parseInput('   '), null)

const c = (id, title, year, kind = 'series') => ({ id, title, year, kind })

// One exact match wins over fuzzier ones, ignoring case and punctuation.
assert.equal(pickCandidate("x men 97", [c('tt1', "X-Men '97", 2024), c('tt2', 'X-Men', 1992)]).pick.id, 'tt1')
// A single result is taken as is.
assert.equal(pickCandidate('severence', [c('tt11280740', 'Severance', 2022)]).pick.id, 'tt11280740')
// Two exact matches: ask, newest first, and only among the exact ones.
const normal = pickCandidate('Normal', [c('tt3', 'Normal', 2003, 'movie'), c('tt4', 'Normal', 2025, 'movie'), c('tt5', 'Normal People', 2020)])
assert.deepEqual(normal.choices.map((x) => x.id), ['tt4', 'tt3'])
// No exact match among several: ask, at most four.
const many = pickCandidate('star', [1, 2, 3, 4, 5].map((n) => c(`tt${n}`, `Star ${n}`, 2000 + n)))
assert.equal(many.choices.length, 4)
assert.equal(many.choices[0].id, 'tt5')
assert.deepEqual(pickCandidate('nothing', []), { none: true })

// Popularity settles same-named titles only when one clearly dominates.
const p = (id, title, year, kind, popularity) => ({ ...c(id, title, year, kind), popularity })
const sev = pickCandidate('Severance', [p('tt6', 'Severance', 2022, 'series', 60), p('tt7', 'Severance', 2006, 'movie', 3), p('tt8', 'Severance', 2019, 'series', 1)])
assert.equal(sev.pick.id, 'tt6')
assert.deepEqual(sev.others.map((x) => x.id), ['tt7', 'tt8'])
const close = pickCandidate('Normal', [p('tt9', 'Normal', 2026, 'movie', 10), p('tt10', 'Normal', 2007, 'movie', 5)])
assert.ok(close.choices, 'a 2× lead is not enough to guess')
// Without popularity for every exact match, it asks.
assert.ok(pickCandidate('Severance', [p('tt6', 'Severance', 2022, 'series', 60), c('tt7', 'Severance', 2006, 'movie')]).choices)
assert.equal(needsPopularity('Severance', [c('tt6', 'Severance', 2022), c('tt7', 'Severance', 2006)]), true)
assert.equal(needsPopularity('Pluribus', [c('tt1', 'Pluribus', 2025), c('tt2', 'Plur', 2001)]), false)

assert.equal(choiceLabel(c('tt4', 'Normal', 2025, 'movie')), 'Normal (2025, film)')
assert.equal(choiceLabel(c('tt5', 'Normal People', null)), 'Normal People (series)')

// A watched show comes back for an episode aired on a later (Istanbul) day.
const today = new Date('2026-10-20T09:00:00Z')
const show = (watchedAt, airDate) => ({ kind: 'series', watchedAt: Date.parse(watchedAt), lastAired: { season: 2, episode: 4, airDate } })
assert.deepEqual(episodeSinceWatched(show('2026-10-10T18:00:00Z', '2026-10-17'), today), { season: 2, episode: 4, airDate: '2026-10-17' })
// Aired the day you finished it: assumed seen.
assert.equal(episodeSinceWatched(show('2026-10-17T20:00:00Z', '2026-10-17'), today), null)
// 23:30 UTC on the 16th is already the 17th in Istanbul.
assert.equal(episodeSinceWatched(show('2026-10-16T23:30:00Z', '2026-10-17'), today), null)
// Announced but not out yet.
assert.equal(episodeSinceWatched(show('2026-10-10T18:00:00Z', '2026-10-25'), today), null)
assert.equal(episodeSinceWatched({ ...show('2026-10-10T18:00:00Z', '2026-10-17'), kind: 'movie' }, today), null)
assert.equal(episodeSinceWatched({ ...show('2026-10-10T18:00:00Z', '2026-10-17'), watchedAt: null }, today), null)

// Release dates: cinema run and age rating from the region, digital from the
// region else the US (labelled), earliest date of each type.
const rd = (iso, dates) => ({ iso_3166_1: iso, release_dates: dates.map(([type, date, certification = '']) => ({ type, release_date: `${date}T00:00:00.000Z`, certification })) })
assert.deepEqual(
  releaseInfo([rd('TR', [[3, '2026-10-23', '13+'], [2, '2026-10-20']]), rd('US', [[4, '2026-12-01', 'PG-13']])], 'TR'),
  { cinemaOpens: '2026-10-20', digital: { date: '2026-12-01', region: 'US' }, ageRating: '13+' },
)
assert.deepEqual(
  releaseInfo([rd('TR', [[4, '2026-11-14']]), rd('US', [[4, '2026-11-01', 'R']])], 'TR'),
  { cinemaOpens: null, digital: { date: '2026-11-14', region: 'TR' }, ageRating: 'R' },
)
assert.deepEqual(releaseInfo(undefined, 'TR'), { cinemaOpens: null, digital: null, ageRating: null })

assert.equal(trailerKey([{ site: 'YouTube', type: 'Teaser', key: 'a' }, { site: 'YouTube', type: 'Trailer', key: 'b' }, { site: 'YouTube', type: 'Trailer', key: 'c', official: true }]), 'c')
assert.equal(trailerKey([{ site: 'Vimeo', type: 'Trailer', key: 'v' }]), null)

assert.equal(truncate('short', 10), 'short')
assert.equal(truncate('one two three four five', 14), 'one two three…')

console.log('watchlist lookup passed')
