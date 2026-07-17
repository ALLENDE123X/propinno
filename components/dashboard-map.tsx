"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { Button } from "@/components/ui/button"
import { InboxNavLink } from "@/components/inbox-nav-link"
import { FavouriteButton } from "@/components/favourite-button"
import { useFavourites } from "@/components/use-favourites"
import { ListingAmenityMap } from "@/components/listing-amenity-map"
import { ListingGallery } from "@/components/listing-image"
import { ListingAttributeBadges } from "@/components/listing-attribute-badges"
import { X, SlidersHorizontal, ExternalLink, Settings, Heart, UserCog } from "lucide-react"
import { formatPrice, timeAgo } from "@/lib/format"

type Listing = {
  id: string
  address: string
  lat: number
  lng: number
  price: number | null
  beds: number | null
  baths: number | null
  source: string
  url: string | null
  postedAt: string | null
  images: string[] | null
  petsAllowed: string | null
  laundryType: string | null
}

type Filters = { minPrice: string; maxPrice: string; minBeds: string; source: string }
type CommuteOverlay = {
  commuteMode: string | null
  commuteMaxMinutes: number | null
  isochrone: { polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon; approximate: boolean } | null
}
const SF_CENTER: [number, number] = [-122.4194, 37.7749]
const FRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const COMMUTE_SOURCE_ID = "commute-isochrone"
const COMMUTE_FILL_LAYER_ID = "commute-isochrone-fill"
const COMMUTE_OUTLINE_LAYER_ID = "commute-isochrone-outline"

// recencyColor takes `now` explicitly (like timeAgo, imported from
// lib/format) rather than calling Date.now() internally, since it's used
// during render and React's purity rule disallows impure calls in render.
function recencyColor(postedAt: string | null, now: number) {
  if (!postedAt) return "#71717a" // zinc-500
  const ms = now - new Date(postedAt).getTime()
  if (ms < 24 * 60 * 60 * 1000) return "#22c55e" // green
  if (ms < FRESH_WINDOW_MS) return "#eab308" // yellow
  return "#71717a"
}

export function DashboardMap() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markers = useRef<mapboxgl.Marker[]>([])
  const [listings, setListings] = useState<Listing[]>([])
  const [selected, setSelected] = useState<Listing | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>({ minPrice: "", maxPrice: "", minBeds: "", source: "" })
  // Ticks once a minute so recency labels/colors and the "fresh in 3 days"
  // stat stay pure during render (derived from state, not a direct Date.now()
  // call) while still updating live as the dashboard stays open.
  const [now, setNow] = useState(() => Date.now())
  const [commute, setCommute] = useState<CommuteOverlay | null>(null)
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  // AH-022 heart/save state, shared with components/inbox-list.tsx via the
  // same hook so both surfaces' toggle logic stays in sync.
  const { isSaved, isPending, toggleFavourite } = useFavourites()

  // Fetch inline (rather than via a useCallback'd helper) and set state only
  // inside the .then()/.catch()/.finally() callbacks: React's hooks lint
  // flags a named helper that calls setState as "setState called directly
  // within an effect" even when the state-setting itself happens after an
  // await, since it can statically see into a same-component closure.
  useEffect(() => {
    const params = new URLSearchParams()
    if (filters.minPrice) params.set("minPrice", filters.minPrice)
    if (filters.maxPrice) params.set("maxPrice", filters.maxPrice)
    if (filters.minBeds) params.set("minBeds", filters.minBeds)
    if (filters.source) params.set("source", filters.source)

    fetch(`/api/listings/map?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load listings")
        return res.json()
      })
      .then((data) => {
        setListings(data.listings || [])
        setError(null)
      })
      .catch(() => {
        setError("Couldn't load listings. Try again shortly.")
      })
      .finally(() => {
        setLoading(false)
      })
  }, [filters])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  // AH-017: fetches the current user's already-cached commute isochrone
  // (never recomputed here - see app/api/dashboard/commute/route.ts and
  // lib/commute.ts). Runs once on mount, independent of the filters-driven
  // listings fetch above, since commute criteria doesn't change from the map
  // UI itself.
  useEffect(() => {
    fetch("/api/dashboard/commute")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCommute(data))
      .catch(() => {
        // Non-fatal: the map still works without the overlay.
      })
  }, [])

  useEffect(() => {
    if (!token || !mapContainer.current || map.current) return
    mapboxgl.accessToken = token
    const instance = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: SF_CENTER,
      zoom: 12,
    })
    // bottom-right, not top-right: the custom stats/filters bar (and the
    // filter panel it opens) both anchor to the top-right corner too, and
    // Mapbox's own control sits on top of them there with no clearance at
    // any viewport width - confirmed by measuring both rects in a real
    // browser, not just eyeballing screenshots. Bottom-right stays clear of
    // both in every state the UI can be in.
    instance.addControl(new mapboxgl.NavigationControl(), "bottom-right")
    map.current = instance

    // Dispose the WebGL context on unmount - without this, React Strict
    // Mode's dev-only double-invoke (and any future remount) leaks a
    // mapboxgl.Map/WebGL context bound to a detached container every time.
    return () => {
      instance.remove()
      map.current = null
    }
  }, [token])

  useEffect(() => {
    if (!map.current) return
    markers.current.forEach((m) => m.remove())
    markers.current = listings.map((listing) => {
      const el = document.createElement("button")
      el.className = "rounded-full border-2 px-2 py-1 text-xs font-semibold text-white shadow-lg cursor-pointer"
      el.style.backgroundColor = "#18181b"
      el.style.borderColor = recencyColor(listing.postedAt, now)
      el.textContent = `${formatPrice(listing.price)} · ${timeAgo(listing.postedAt, now)}`
      el.onclick = () => setSelected(listing)
      return new mapboxgl.Marker({ element: el }).setLngLat([listing.lng, listing.lat]).addTo(map.current!)
    })
  }, [listings, now])

  // AH-017: draws the cached commute isochrone as a translucent fill +
  // outline layer. Unlike markers (which use `.addTo()` and don't care about
  // style load state), `addSource`/`addLayer` throw if the map's style isn't
  // loaded yet - so this waits for `isStyleLoaded()` (or a one-time 'load'
  // event) before touching the map, then updates the existing source's data
  // in place on later changes instead of re-adding layers.
  useEffect(() => {
    const mapInstance = map.current
    if (!mapInstance) return

    const apply = () => {
      const polygon = commute?.isochrone?.polygon ?? null
      const existingSource = mapInstance.getSource(COMMUTE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined

      if (!polygon) {
        if (mapInstance.getLayer(COMMUTE_FILL_LAYER_ID)) mapInstance.removeLayer(COMMUTE_FILL_LAYER_ID)
        if (mapInstance.getLayer(COMMUTE_OUTLINE_LAYER_ID)) mapInstance.removeLayer(COMMUTE_OUTLINE_LAYER_ID)
        if (existingSource) mapInstance.removeSource(COMMUTE_SOURCE_ID)
        return
      }

      const geojson: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: polygon }

      if (existingSource) {
        existingSource.setData(geojson)
        return
      }

      mapInstance.addSource(COMMUTE_SOURCE_ID, { type: "geojson", data: geojson })
      mapInstance.addLayer({
        id: COMMUTE_FILL_LAYER_ID,
        type: "fill",
        source: COMMUTE_SOURCE_ID,
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.15 },
      })
      mapInstance.addLayer({
        id: COMMUTE_OUTLINE_LAYER_ID,
        type: "line",
        source: COMMUTE_SOURCE_ID,
        paint: { "line-color": "#3b82f6", "line-width": 2, "line-opacity": 0.6 },
      })
    }

    if (mapInstance.isStyleLoaded()) {
      apply()
    } else {
      mapInstance.once("load", apply)
    }
  }, [commute])

  const freshCount = listings.filter(
    (l) => l.postedAt && now - new Date(l.postedAt).getTime() < FRESH_WINDOW_MS
  ).length

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white text-center p-6">
        Map unavailable — Mapbox token not configured.
      </div>
    )
  }

  return (
    <div className="relative h-screen w-full bg-black">
      {/* mapbox-gl's own stylesheet sets `.mapboxgl-map { position: relative }`,
          which overrides Tailwind's `.absolute` utility on this element (same
          specificity, mapbox-gl.css is injected after Tailwind's compiled
          sheet) and collapses this container to zero height. Fill the parent
          via width/height instead of `absolute inset-0` so nothing here
          depends on winning that cascade fight; the parent is already
          `relative h-screen`, so this stays in normal flow at full size while
          the overlay UI below uses `absolute` (a class mapbox-gl never
          touches) to sit on top of it. */}
      <div ref={mapContainer} className="h-full w-full" />

      <div className="absolute top-4 left-4 right-4 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2 flex-wrap">
          <div className="bg-zinc-900/90 border border-zinc-800 rounded-full px-4 py-2 text-sm text-white backdrop-blur">
            {loading ? "Loading listings…" : `${freshCount} fresh listings in the last 3 days`}
          </div>
          {commute?.isochrone && (
            <div className="bg-blue-950/80 border border-blue-800/60 rounded-full px-4 py-2 text-xs text-blue-200 backdrop-blur">
              Commute zone: ≤{commute.commuteMaxMinutes} min {commute.commuteMode}
              {commute.isochrone.approximate ? " (estimated, not real transit routing)" : ""}
            </div>
          )}
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <InboxNavLink />
          <Link href="/dashboard/favourites">
            <Button
              size="sm"
              className="bg-zinc-900/90 border border-zinc-800 text-white hover:bg-zinc-800"
            >
              <Heart className="w-4 h-4 mr-2" /> Favourites
            </Button>
          </Link>
          <Button
            size="sm"
            className="bg-zinc-900/90 border border-zinc-800 text-white hover:bg-zinc-800"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <SlidersHorizontal className="w-4 h-4 mr-2" /> Filters
          </Button>
          <Link href="/dashboard/profile">
            <Button
              size="sm"
              className="bg-zinc-900/90 border border-zinc-800 text-white hover:bg-zinc-800"
              aria-label="Search profile"
            >
              <UserCog className="w-4 h-4 mr-2" /> Search Profile
            </Button>
          </Link>
          <Link href="/dashboard/settings">
            <Button
              size="sm"
              className="bg-zinc-900/90 border border-zinc-800 text-white hover:bg-zinc-800"
              aria-label="Notification settings"
            >
              <Settings className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </div>

      {error && (
        <div className="absolute top-16 left-4 right-4 bg-red-900/90 text-white text-sm rounded-lg p-3 text-center">
          {error}
        </div>
      )}

      {filtersOpen && (
        <div className="absolute md:top-16 md:right-4 bottom-0 md:bottom-auto left-0 md:left-auto w-full md:w-72 bg-zinc-900 border-t md:border border-zinc-800 md:rounded-xl p-4 space-y-3 text-white z-10">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Filters</h3>
            <button onClick={() => setFiltersOpen(false)}><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" placeholder="Min $" value={filters.minPrice}
              onChange={(e) => setFilters({ ...filters, minPrice: e.target.value })}
              className="bg-zinc-800 rounded-md px-2 py-1.5 text-sm w-full" />
            <input type="number" placeholder="Max $" value={filters.maxPrice}
              onChange={(e) => setFilters({ ...filters, maxPrice: e.target.value })}
              className="bg-zinc-800 rounded-md px-2 py-1.5 text-sm w-full" />
          </div>
          <select value={filters.minBeds} onChange={(e) => setFilters({ ...filters, minBeds: e.target.value })}
            className="bg-zinc-800 rounded-md px-2 py-1.5 text-sm w-full">
            <option value="">Any beds</option>
            <option value="0">Studio+</option>
            <option value="1">1+ bed</option>
            <option value="2">2+ beds</option>
            <option value="3">3+ beds</option>
          </select>
          <select value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })}
            className="bg-zinc-800 rounded-md px-2 py-1.5 text-sm w-full">
            <option value="">All sources</option>
            <option value="rentcast">RentCast</option>
            <option value="craigslist">Craigslist</option>
            <option value="facebook">Facebook Marketplace</option>
            <option value="realtor">Realtor.com</option>
            <option value="apartments">Apartments.com</option>
            <option value="apartmentlist">Apartment List</option>
            <option value="zumper">Zumper</option>
            <option value="spareroom">SpareRoom</option>
          </select>
        </div>
      )}

      {selected && (
        <div className="absolute bottom-0 md:bottom-6 left-0 md:left-6 w-full md:w-96 max-h-[85vh] overflow-y-auto bg-zinc-900 border-t md:border border-zinc-800 md:rounded-xl p-5 text-white z-10">
          <div className="flex justify-between items-start mb-2">
            <h3 className="font-semibold text-lg">{formatPrice(selected.price)}/mo</h3>
            <div className="flex items-center gap-1">
              <FavouriteButton
                saved={isSaved(selected.id)}
                pending={isPending(selected.id)}
                onToggle={() => toggleFavourite(selected.id)}
              />
              <button onClick={() => setSelected(null)}><X className="w-4 h-4" /></button>
            </div>
          </div>
          <p className="text-zinc-400 text-sm mb-3">{selected.address}</p>
          {/* Primary photo + click-through thumbnail strip when a listing
              has more than one image (Craigslist/Facebook only - RentCast
              has no image data). Single-image and no-image listings render
              a single hero image or a neutral placeholder, never a gap. */}
          <ListingGallery images={selected.images} alt={selected.address} className="mb-4" />
          <div className="flex gap-4 text-sm text-zinc-300 mb-4">
            <span>{selected.beds ?? "?"} bd</span>
            <span>{selected.baths ?? "?"} ba</span>
            <span className="capitalize">{selected.source}</span>
            <span>Posted {timeAgo(selected.postedAt, now)} ago</span>
          </div>
          {/* AH-027: pets/laundry badges, rendered only when the listing has
              a real parsed value for at least one of them (see
              components/listing-attribute-badges.tsx for the null-means-
              "couldn't parse" convention). */}
          <ListingAttributeBadges
            petsAllowed={selected.petsAllowed}
            laundryType={selected.laundryType}
            className="mb-4"
          />
          {selected.url && (
            <a href={selected.url} target="_blank" rel="noopener noreferrer">
              <Button className="w-full bg-white text-black hover:bg-zinc-200">
                View listing <ExternalLink className="w-4 h-4 ml-2" />
              </Button>
            </a>
          )}
          {/* AH-023: nearby grocery/gym/transit/bike-share mini-map + list.
              Keyed by listing id so switching between markers without
              closing the card remounts (and re-fetches/re-inits the small
              map) instead of reusing stale state. */}
          <ListingAmenityMap key={selected.id} listingId={selected.id} lat={selected.lat} lng={selected.lng} />
        </div>
      )}
    </div>
  )
}
