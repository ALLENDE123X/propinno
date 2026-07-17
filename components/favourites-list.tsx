"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ListingImage } from "@/components/listing-image"
import { formatPrice, timeAgo } from "@/lib/format"
import { ArrowLeft, ExternalLink, Heart, Loader2 } from "lucide-react"

type FavouriteItem = {
  listingId: string
  address: string
  price: number | null
  beds: number | null
  baths: number | null
  source: string
  url: string | null
  postedAt: string | null
  images: string[] | null
  savedAt: string
}

// Client component for /dashboard/favourites (AH-022). Fetches inline
// (rather than via a useCallback'd helper) and sets state only inside the
// .then()/.catch()/.finally() callbacks, matching components/inbox-list.tsx's
// established pattern for the same hooks-lint reason documented there.
// Deliberately doesn't reuse the components/use-favourites.ts hook -- that
// hook only tracks a Set of saved listingIds for heart-icon state elsewhere,
// while this page needs the full joined listing details GET /api/favourites
// already returns, plus optimistic per-item removal on unsave (same
// interaction pattern as inbox-list.tsx's dismiss button) rather than a
// saved/unsaved toggle.
export function FavouritesList() {
  const [items, setItems] = useState<FavouriteItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // listingIds currently mid-request, so buttons disable individually rather
  // than the whole list locking up on one action.
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    fetch("/api/favourites")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load favourites")
        return res.json()
      })
      .then((data) => {
        setItems(data.items || [])
        setError(null)
      })
      .catch(() => {
        setError("Couldn't load your favourites. Try again shortly.")
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  async function unsave(listingId: string) {
    setPending((prev) => new Set(prev).add(listingId))
    try {
      const res = await fetch(`/api/favourites/${listingId}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to remove favourite")
      setItems((prev) => prev.filter((item) => item.listingId !== listingId))
    } catch {
      setError("Couldn't remove that listing. Try again.")
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(listingId)
        return next
      })
    }
  }

  return (
    <div className="min-h-screen w-full bg-black p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link
              href="/dashboard"
              className="mb-2 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-white"
            >
              <ArrowLeft className="w-4 h-4" /> Back to map
            </Link>
            <h1 className="text-2xl font-bold text-white">Favourites</h1>
            <p className="text-sm text-zinc-400">
              {loading
                ? "Loading…"
                : items.length > 0
                  ? `${items.length} saved listing${items.length === 1 ? "" : "s"}`
                  : "Nothing saved yet"}
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/90 p-3 text-center text-sm text-white">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-white" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
            <Heart className="mx-auto mb-3 w-8 h-8 text-zinc-600" />
            <h2 className="text-lg font-semibold text-white">Nothing saved yet</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Tap the heart on any listing to save it here for later comparison.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => {
              const isPending = pending.has(item.listingId)
              return (
                <li
                  key={item.listingId}
                  className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <ListingImage
                        src={item.images?.[0]}
                        alt={item.address}
                        className="w-14 h-14 shrink-0 rounded-lg"
                      />
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-white">{item.address}</p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-400">
                          <span>{formatPrice(item.price)}/mo</span>
                          <span>{item.beds ?? "?"} bd</span>
                          <span>{item.baths ?? "?"} ba</span>
                          <span className="capitalize">{item.source}</span>
                          <span>Saved {timeAgo(item.savedAt, now)} ago</span>
                        </div>
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Remove from favourites"
                      disabled={isPending}
                      onClick={() => unsave(item.listingId)}
                      className="h-8 w-8 shrink-0 text-red-500 hover:bg-zinc-800 hover:text-red-400"
                    >
                      <Heart className="w-4 h-4 fill-current" />
                    </Button>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noopener noreferrer">
                        <Button
                          size="sm"
                          className="bg-white text-black hover:bg-zinc-200"
                          disabled={isPending}
                        >
                          View listing <ExternalLink className="ml-1.5 w-3.5 h-3.5" />
                        </Button>
                      </a>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
