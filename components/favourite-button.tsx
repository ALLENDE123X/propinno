"use client"

import { Heart } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type FavouriteButtonProps = {
  saved: boolean
  pending: boolean
  onToggle: () => void
  className?: string
}

// Shared heart/save icon (AH-022), used by both components/dashboard-map.tsx's
// detail card and components/inbox-list.tsx's item rows so the toggle button
// itself isn't duplicated -- the save/unsave mutation and "which listings are
// saved" state live in the useFavourites hook (components/use-favourites.ts),
// this component is purely presentational. Uses cn() (never raw className
// concatenation) per this codebase's shared-component convention.
export function FavouriteButton({ saved, pending, onToggle, className }: FavouriteButtonProps) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={saved ? "Remove from favourites" : "Save listing"}
      aria-pressed={saved}
      disabled={pending}
      onClick={(e) => {
        // Listing cards this appears on (the dashboard map marker's detail
        // card, inbox rows) are themselves clickable/wrapped in other
        // interactive elements -- stop the click from bubbling into those.
        e.stopPropagation()
        e.preventDefault()
        onToggle()
      }}
      className={cn(
        "h-8 w-8 shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-white",
        saved && "text-red-500 hover:text-red-400",
        className
      )}
    >
      <Heart className={cn("w-4 h-4", saved && "fill-current")} />
    </Button>
  )
}
