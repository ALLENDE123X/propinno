"use client"

import { useState } from "react"
import { ImageOff } from "lucide-react"
import { cn } from "@/lib/utils"

// Shared listing-image display, used by components/dashboard-map.tsx's
// detail card, components/inbox-list.tsx's rows, and
// components/favourites-list.tsx's rows - the "add an image consistently
// everywhere a listing card renders" requirement.
//
// Plain <img> tags rather than next/image: image URLs come from whichever
// source a listing was polled from (Craigslist's own CDN, Facebook's
// signed/expiring fbcdn.net URLs, and - once RentCast or a future source
// ever adds photos - potentially any other domain). next/image requires each
// remote host to be allowlisted in next.config.ts's images.remotePatterns
// ahead of time; with 5 more listing-source pollers planned on top of this
// pattern, hardcoding a domain allowlist here would mean editing this file
// (or next.config.ts) again for every new source. A plain <img> has no such
// allowlist and degrades via onError below instead of a build/runtime
// config error.
//
// Missing/broken images are a certainty, not an edge case - not every
// listing across every source has photos (confirmed live: RentCast has zero
// image data at all), and even a real URL can 404 later (Facebook's CDN
// links expire). Both cases render the same neutral placeholder rather than
// a broken-image icon or any layout shift, since the container size is
// fixed by the wrapping className regardless of which branch renders.

type ListingImageProps = {
  src: string | null | undefined
  alt: string
  className?: string
}

function Placeholder({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center bg-zinc-800 text-zinc-600",
        className
      )}
      aria-hidden
    >
      <ImageOff className="w-1/4 h-1/4 min-w-4 min-h-4" />
    </div>
  )
}

// Single image with graceful fallback - the "primary/thumbnail image"
// building block every listing-card surface uses.
export function ListingImage({ src, alt, className }: ListingImageProps) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return <Placeholder className={className} />
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("object-cover bg-zinc-800", className)}
    />
  )
}

type ListingGalleryProps = {
  images: string[] | null | undefined
  alt: string
  className?: string
}

// Larger hero image + click-through thumbnail strip for the dashboard map's
// detail card (the one surface roomy enough for a real gallery). Falls back
// to a single ListingImage/placeholder when a listing has 0-1 photos, which
// covers every source's common case today - RentCast never has photos,
// Facebook's `primary_listing_photo`-only fallback path also produces a
// single-element array.
export function ListingGallery({ images, alt, className }: ListingGalleryProps) {
  const list = images?.filter((src) => typeof src === "string" && src.length > 0) ?? []
  const [activeIndex, setActiveIndex] = useState(0)
  // activeIndex is only ever set via setActiveIndex(i) below, where `i` is a
  // literal array index from list.map itself - not attacker-controlled, same
  // reasoning as lib/commute.ts's existing ring-index suppressions.
  // eslint-disable-next-line security/detect-object-injection
  const active = list[activeIndex] ?? list[0] ?? null

  if (list.length === 0) {
    return <Placeholder className={cn("w-full h-48 rounded-lg", className)} />
  }

  return (
    <div className={className}>
      <ListingImage src={active} alt={alt} className="w-full h-48 rounded-lg" />
      {list.length > 1 && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {list.map((src, i) => (
            <button
              key={src + i}
              type="button"
              onClick={() => setActiveIndex(i)}
              aria-label={`Show photo ${i + 1} of ${list.length}`}
              aria-current={i === activeIndex}
              className={cn(
                "shrink-0 w-12 h-12 rounded-md overflow-hidden border-2 transition-colors",
                i === activeIndex ? "border-white" : "border-transparent opacity-70 hover:opacity-100"
              )}
            >
              <ListingImage src={src} alt="" className="w-full h-full" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
