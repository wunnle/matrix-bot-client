import { useEffect, useRef, useState } from 'react'
import { loadMapkit } from '../lib/mapkit'
import { currentLocation, formatCoords } from '../lib/location'
import { hapticTick } from '../lib/haptics'
import type { SharedLocation } from '../types'

interface Props {
  onClose: () => void
  onSend: (loc: SharedLocation, kind: 'self' | 'pin') => void
}

// What Send would send right now: where you are, or wherever the pin sits.
type Choice =
  | { kind: 'self' }
  | { kind: 'pin', lat: number, lon: number, title?: string, subtitle?: string }

// About 500 m top to bottom: streets and their names, not the whole district.
const SPAN_DEG = 0.005

/**
 * Full-screen map with a fixed centre pin, like Messages and WhatsApp: drag the
 * map under the pin, or search, and the card at the bottom says what Send
 * would share. It opens on your own location, which stays one tap away.
 */
export default function LocationPicker({ onClose, onSend }: Props) {
  const mapEl = useRef<HTMLDivElement>(null)
  const bottomEl = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [map, setMap] = useState<mapkit.Map | null>(null)
  const [mapError, setMapError] = useState<string>()
  const [here, setHere] = useState<SharedLocation>()
  const [hereError, setHereError] = useState<string>()
  const [choice, setChoice] = useState<Choice>({ kind: 'self' })
  const [dragging, setDragging] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<mapkit.SearchAutocompleteResult[]>([])
  // Where a move we started is headed, so its region-change-end isn't read as
  // the user dropping the pin there.
  const expected = useRef<{ lat: number, lon: number } | null>(null)
  const lookup = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    currentLocation().then(setHere, (err: Error) => setHereError(err.message))
  }, [])

  useEffect(() => {
    let cancelled = false
    loadMapkit().then((mk) => {
      if (cancelled || !mapEl.current) return
      // Inset the logo and Legal link above the bottom card. Top and bottom
      // match so the padded centre is still the screen centre, where the pin is.
      const inset = bottomEl.current ? Math.ceil(window.innerHeight - bottomEl.current.getBoundingClientRect().top) : 0
      setMap(new mk.Map(mapEl.current, {
        padding: new mk.Padding(inset, 0, inset, 0),
        colorScheme: mk.Map.ColorSchemes.Dark,
        showsCompass: mk.FeatureVisibility.Hidden,
        showsScale: mk.FeatureVisibility.Hidden,
        showsMapTypeControl: false,
        showsZoomControl: false,
        showsUserLocationControl: false,
        isRotationEnabled: false,
      }))
    }, (err: Error) => setMapError(err.message))
    return () => { cancelled = true }
  }, [])

  const moveTo = (lat: number, lon: number, animate = true) => {
    if (!map) return
    expected.current = { lat, lon }
    map.setRegionAnimated(new mapkit.CoordinateRegion(new mapkit.Coordinate(lat, lon), new mapkit.CoordinateSpan(SPAN_DEG, SPAN_DEG)), animate)
  }

  // Open on your own location once both the map and the fix are in.
  const centred = useRef(false)
  useEffect(() => {
    if (!map || !here || centred.current) return
    centred.current = true
    moveTo(here.lat, here.lon, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, here])

  // Your own position as a dot. Not showsUserLocation: that asks the WebView
  // for the location, which brings back the "localhost" prompt in the app.
  useEffect(() => {
    if (!map || !here) return
    const dot = new mapkit.Annotation(
      new mapkit.Coordinate(here.lat, here.lon),
      () => Object.assign(document.createElement('div'), { className: 'loc-picker-me' }),
      { enabled: false, anchorOffset: new DOMPoint(0, -8) },
    )
    map.addAnnotation(dot)
    return () => { map.removeAnnotation(dot) }
  }, [map, here])

  const describe = (lat: number, lon: number, title?: string, subtitle?: string) => {
    setChoice({ kind: 'pin', lat, lon, title, subtitle })
    if (title) return
    const id = ++lookup.current
    new mapkit.Geocoder().reverseLookup(new mapkit.Coordinate(lat, lon), (err, data) => {
      if (id !== lookup.current) return
      const place = err ? undefined : data.results[0]
      if (!place) return
      const rest = place.formattedAddress.startsWith(place.name)
        ? place.formattedAddress.slice(place.name.length).replace(/^,\s*/, '')
        : place.formattedAddress
      setChoice({ kind: 'pin', lat, lon, title: place.name, subtitle: rest || undefined })
    })
  }

  useEffect(() => {
    if (!map) return
    const onStart = () => {
      if (!expected.current) setDragging(true)
    }
    const onEnd = () => {
      setDragging(false)
      const { latitude: lat, longitude: lon } = map.center
      const target = expected.current
      expected.current = null
      // Ours if it ended where we sent it (within a few metres).
      if (target && Math.abs(target.lat - lat) < 1e-4 && Math.abs(target.lon - lon) < 1e-4) return
      hapticTick()
      describe(lat, lon)
    }
    map.addEventListener('region-change-start', onStart)
    map.addEventListener('region-change-end', onEnd)
    return () => {
      map.removeEventListener('region-change-start', onStart)
      map.removeEventListener('region-change-end', onEnd)
    }
  }, [map])

  // Declared after every other effect that touches the map, because React runs
  // unmount cleanups in declaration order: a destroyed map throws on
  // removeAnnotation, and that blanked the whole app when the picker closed.
  useEffect(() => () => map?.destroy(), [map])

  // Suggestions as you type, biased to what's on screen.
  useEffect(() => {
    const q = query.trim()
    if (!map || !q) return
    let stale = false
    const t = setTimeout(() => {
      new mapkit.Search({ region: map.region }).autocomplete(q, (err, data) => {
        if (!stale) setResults(err ? [] : data.results)
      })
    }, 200)
    return () => { stale = true; clearTimeout(t) }
  }, [map, query])

  const pickResult = (r: mapkit.SearchAutocompleteResult) => {
    const [title, subtitle] = r.displayLines
    setQuery('')
    setResults([])
    inputRef.current?.blur()
    const go = (lat: number, lon: number) => {
      lookup.current++
      describe(lat, lon, title, subtitle)
      moveTo(lat, lon)
    }
    if (r.coordinate) { go(r.coordinate.latitude, r.coordinate.longitude); return }
    // A query suggestion ("coffee") has no coordinate of its own; take its top place.
    new mapkit.Search({ region: map?.region }).search(r, (err, data) => {
      const place = err ? undefined : data.places[0]
      if (place) go(place.coordinate.latitude, place.coordinate.longitude)
    })
  }

  const backToMe = () => {
    if (!here) return
    hapticTick()
    lookup.current++
    setChoice({ kind: 'self' })
    moveTo(here.lat, here.lon)
  }

  const send = () => {
    if (choice.kind === 'self') {
      if (here) onSend(here, 'self')
      return
    }
    onSend({ lat: choice.lat, lon: choice.lon, description: choice.title }, 'pin')
  }

  // Cleared queries keep their last results around; only show them while typing.
  const shown = query.trim() ? results : []
  const canSend = choice.kind === 'pin' || !!here
  const title = choice.kind === 'pin'
    ? (choice.title ?? 'Dropped pin')
    : here ? 'Your location' : hereError ? 'Location unavailable' : 'Finding your location…'
  const subtitle = choice.kind === 'pin'
    ? (choice.subtitle ?? formatCoords(choice))
    : here ? `±${here.accuracy} m` : hereError ?? ''

  return (
    <div className="loc-picker" role="dialog" aria-label="Share a location">
      <div ref={mapEl} className={`loc-picker-map${map && (here || hereError) ? ' loc-picker-map--ready' : ''}`} />
      {mapError && <div className="loc-picker-map-error">{mapError}</div>}
      {map && (
        <span
          className={`material-icons loc-picker-pin${dragging ? ' loc-picker-pin--lifted' : ''}${choice.kind === 'self' ? ' loc-picker-pin--hidden' : ''}`}
          aria-hidden
        >location_on</span>
      )}

      <div className="loc-picker-top">
        <button type="button" className="loc-picker-round glass" onClick={onClose} aria-label="Close">
          <span className="material-icons" aria-hidden>close</span>
        </button>
        <label className="loc-picker-search glass">
          <span className="material-icons" aria-hidden>search</span>
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            placeholder="Search places"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) pickResult(shown[0]) }}
            disabled={!map}
          />
        </label>
      </div>

      {shown.length > 0 && (
        <ul className="loc-picker-results glass" role="listbox">
          {shown.slice(0, 6).map((r, i) => (
            <li key={i}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickResult(r)}>
                <span className="loc-picker-result-title">{r.displayLines[0]}</span>
                {r.displayLines[1] && <span className="loc-picker-result-sub">{r.displayLines[1]}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div ref={bottomEl} className="loc-picker-bottom">
        {here && choice.kind === 'pin' && (
          <button type="button" className="loc-picker-round loc-picker-me-btn glass" onClick={backToMe} aria-label="Back to your location">
            <span className="material-icons" aria-hidden>near_me</span>
          </button>
        )}
        <div className={`loc-picker-card glass${dragging ? ' loc-picker-card--moving' : ''}`}>
          <span className="material-icons loc-picker-card-icon" aria-hidden>
            {choice.kind === 'pin' ? 'location_on' : 'near_me'}
          </span>
          <span className="loc-picker-card-text">
            <span className="loc-picker-card-title">{title}</span>
            {subtitle && <span className="loc-picker-card-sub">{subtitle}</span>}
          </span>
          <button
            type="button"
            className="loc-picker-send"
            onClick={send}
            disabled={!canSend || dragging}
            aria-label="Send location"
          >
            <span className="material-icons" aria-hidden>arrow_upward</span>
          </button>
        </div>
      </div>
    </div>
  )
}
