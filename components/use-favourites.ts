"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * Shared save/unsave (heart icon) state (AH-022), used by both
 * components/dashboard-map.tsx's detail card and components/inbox-list.tsx's
 * item rows so neither duplicates the fetch-then-toggle logic.
 *
 * Reuses GET /api/favourites (the same endpoint the favourites page itself
 * calls) as the source of truth for "which listings are currently saved"
 * rather than adding a separate ids-only endpoint -- that list is
 * realistically small, and this codebase already tolerates one full fetch
 * per component on mount for a similar purpose (InboxNavLink's
 * /api/inbox/unread-count). Fetches inline and sets state only inside the
 * .then()/.catch() callbacks, matching dashboard-map.tsx's/inbox-list.tsx's
 * established pattern for the same hooks-lint reason documented there.
 */
export function useFavourites() {
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch("/api/favourites")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.items) {
          setSavedIds(new Set(data.items.map((item: { listingId: string }) => item.listingId)))
        }
      })
      .catch(() => {
        // Non-fatal: heart icons just default to "not saved" if this fails.
      })
  }, [])

  const toggleFavourite = useCallback(
    async (listingId: string) => {
      const wasSaved = savedIds.has(listingId)
      setPending((prev) => new Set(prev).add(listingId))
      try {
        const res = await fetch(`/api/favourites/${listingId}`, {
          method: wasSaved ? "DELETE" : "POST",
        })
        if (!res.ok) throw new Error("Failed to update favourite")

        setSavedIds((prev) => {
          const next = new Set(prev)
          if (wasSaved) {
            next.delete(listingId)
          } else {
            next.add(listingId)
          }
          return next
        })
        return true
      } catch {
        return false
      } finally {
        setPending((prev) => {
          const next = new Set(prev)
          next.delete(listingId)
          return next
        })
      }
    },
    [savedIds]
  )

  const isSaved = useCallback((listingId: string) => savedIds.has(listingId), [savedIds])
  const isPending = useCallback((listingId: string) => pending.has(listingId), [pending])

  return { isSaved, isPending, toggleFavourite }
}
