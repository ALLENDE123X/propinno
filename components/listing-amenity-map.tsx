"use client"

import { useEffect, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { ShoppingCart, Dumbbell, TrainFront, Bike, Loader2 } from "lucide-react"
import type { AmenityCategory, NearbyAmenity } from "@/lib/amenities"

type Props = {
  listingId: string
  lat: number
  lng: number
}

type AmenityResponse = {
  amenities: NearbyAmenity[]
  computedAt: string | null
  cached: boolean
  reason?: "no_coordinates" | "budget_exceeded" | "computation_failed"
}

const CATEGORY_META: Record<AmenityCategory, { label: string; color: string; Icon: typeof ShoppingCart }> = {
  grocery: { label: "Grocery", color: "#22c55e", Icon: ShoppingCart },
  gym: { label: "Gym", color: "#f97316", Icon: Dumbbell },
  transit: { label: "Transit", color: "#3b82f6", Icon: TrainFront },
  bike_share: { label: "Bike share", color: "#eab308", Icon: Bike },
}

// AH-023: nearby-amenity mini-map + list, rendered inside
// components/dashboard-map.tsx's existing click-to-open detail card (see
// that component's header comment for why this is the "listing detail"
// surface in this codebase rather than a new route). Reuses the same
// Mapbox GL JS instance-per-mount / dispose-on-unmount pattern
// dashboard-map.tsx already established, just smaller and non-interactive
// (this is a focused preview, not something a user pans/zooms).
//
// Fetches GET /api/listings/[listingId]/amenities on mount, which itself
// serves an already-cached result on every call after the first - see
// lib/amenities.ts's header comment for the full "compute once" design.
// Walking times/distances shown here are real Mapbox Directions routing
// output; block counts are a documented approximation (see
// lib/amenities.ts's SF_BLOCK_METERS) - never presented as exact.
export function ListingAmenityMap({ listingId, lat, lng }: Props) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markers = useRef<mapboxgl.Marker[]>([])
  const [data, setData] = useState<AmenityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

  // Fetch inline and set state only inside the .then()/.catch()/.finally()
  // callbacks - same reasoning as components/dashboard-map.tsx's own listings
  // effect (React's hooks lint flags any setState called synchronously in an
  // effect body, including a reset at the top). This component is mounted
  // fresh per listing (see dashboard-map.tsx's `key={selected.id}` on this
  // component), so the initial useState values above already serve as the
  // per-listing reset - no manual reset needed here.
  useEffect(() => {
    fetch(`/api/listings/${listingId}/amenities`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load amenities")
        return res.json()
      })
      .then((json) => setData(json))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [listingId])

  useEffect(() => {
    if (!token || !mapContainer.current || map.current) return
    mapboxgl.accessToken = token
    const instance = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [lng, lat],
      zoom: 15,
      // Small focused preview inside the detail card, not a full map the
      // user is meant to pan/zoom - keeps it visually calm next to the
      // main dashboard map behind it.
      interactive: false,
      attributionControl: false,
    })
    map.current = instance

    // Same WebGL-context cleanup reasoning as dashboard-map.tsx: without
    // this, remounting this component (e.g. selecting a different listing)
    // leaks a mapboxgl.Map bound to a detached container.
    return () => {
      instance.remove()
      map.current = null
    }
  }, [token, lat, lng])

  useEffect(() => {
    if (!map.current) return
    markers.current.forEach((m) => m.remove())
    markers.current = []

    const listingEl = document.createElement("div")
    listingEl.className = "h-3 w-3 rounded-full bg-white border-2 border-zinc-900 shadow"
    markers.current.push(new mapboxgl.Marker({ element: listingEl }).setLngLat([lng, lat]).addTo(map.current))

    for (const amenity of data?.amenities ?? []) {
      const meta = CATEGORY_META[amenity.category]
      const el = document.createElement("div")
      el.className = "h-3 w-3 rounded-full border-2 border-zinc-900 shadow"
      el.style.backgroundColor = meta.color
      el.title = amenity.name
      markers.current.push(
        new mapboxgl.Marker({ element: el }).setLngLat([amenity.lng, amenity.lat]).addTo(map.current!)
      )
    }
  }, [data, lat, lng])

  if (!token) return null // Detail card still works fully without this section.

  return (
    <div className="mt-4 border-t border-zinc-800 pt-4">
      <h4 className="mb-2 text-sm font-semibold text-white">Nearby</h4>
      <div ref={mapContainer} className="h-32 w-full rounded-lg overflow-hidden" />

      <div className="mt-2 space-y-1.5">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" /> Finding nearby amenities…
          </div>
        ) : error ? (
          <p className="text-xs text-zinc-500">Couldn&apos;t load nearby amenities.</p>
        ) : data && data.amenities.length > 0 ? (
          <>
            {data.amenities.map((a) => {
              const meta = CATEGORY_META[a.category]
              const Icon = meta.Icon
              return (
                <div key={a.category} className="flex items-center gap-2 text-xs text-zinc-300">
                  <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: meta.color }} />
                  <span className="truncate">{a.name}</span>
                  <span className="ml-auto shrink-0 whitespace-nowrap text-zinc-500">
                    {a.walkMinutes} min &middot; ~{a.blocksApprox} {a.blocksApprox === 1 ? "block" : "blocks"}
                  </span>
                </div>
              )
            })}
            <p className="pt-1 text-[10px] text-zinc-600">
              Walking times are real routes; block counts are approximate.
            </p>
          </>
        ) : data?.reason === "budget_exceeded" ? (
          <p className="text-xs text-zinc-500">Nearby amenities are temporarily unavailable. Try again later.</p>
        ) : data?.reason === "no_coordinates" ? (
          <p className="text-xs text-zinc-500">No amenity data available for this listing.</p>
        ) : (
          <p className="text-xs text-zinc-500">No grocery, gym, transit, or bike share found within 0.5 mi.</p>
        )}
      </div>
    </div>
  )
}
