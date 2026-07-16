"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { Button } from "@/components/ui/button"
import { InboxNavLink } from "@/components/inbox-nav-link"
import { X, SlidersHorizontal, ExternalLink, Settings } from "lucide-react"
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
}

type Filters = { minPrice: string; maxPrice: string; minBeds: string; source: string }
const SF_CENTER: [number, number] = [-122.4194, 37.7749]
const FRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

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
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

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
        <div className="pointer-events-auto bg-zinc-900/90 border border-zinc-800 rounded-full px-4 py-2 text-sm text-white backdrop-blur">
          {loading ? "Loading listings…" : `${freshCount} fresh listings in the last 3 days`}
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <InboxNavLink />
          <Button
            size="sm"
            className="bg-zinc-900/90 border border-zinc-800 text-white hover:bg-zinc-800"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <SlidersHorizontal className="w-4 h-4 mr-2" /> Filters
          </Button>
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
          </select>
        </div>
      )}

      {selected && (
        <div className="absolute bottom-0 md:bottom-6 left-0 md:left-6 w-full md:w-96 bg-zinc-900 border-t md:border border-zinc-800 md:rounded-xl p-5 text-white z-10">
          <div className="flex justify-between items-start mb-2">
            <h3 className="font-semibold text-lg">{formatPrice(selected.price)}/mo</h3>
            <button onClick={() => setSelected(null)}><X className="w-4 h-4" /></button>
          </div>
          <p className="text-zinc-400 text-sm mb-3">{selected.address}</p>
          <div className="flex gap-4 text-sm text-zinc-300 mb-4">
            <span>{selected.beds ?? "?"} bd</span>
            <span>{selected.baths ?? "?"} ba</span>
            <span className="capitalize">{selected.source}</span>
            <span>Posted {timeAgo(selected.postedAt, now)} ago</span>
          </div>
          {selected.url && (
            <a href={selected.url} target="_blank" rel="noopener noreferrer">
              <Button className="w-full bg-white text-black hover:bg-zinc-200">
                View listing <ExternalLink className="w-4 h-4 ml-2" />
              </Button>
            </a>
          )}
        </div>
      )}
    </div>
  )
}
