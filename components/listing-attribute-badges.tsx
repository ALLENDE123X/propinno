import { PawPrint, WashingMachine } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PetsAllowed, LaundryType } from "@/lib/listingAttributes"

// AH-027 — shared pets/laundry badges, used by components/dashboard-map.tsx's
// detail card, components/inbox-list.tsx's rows, and
// components/favourites-list.tsx's rows: the same "one shared component
// reused across all three listing-card surfaces" pattern as
// components/listing-image.tsx (see that file's own header comment).
//
// Both `listings.petsAllowed`/`listings.laundryType` are nullable, and null
// means "couldn't be parsed from the source data" (see
// lib/listingAttributes.ts), never "no pets"/"no laundry" -- so this
// component renders nothing at all (no badge, no placeholder, no "unknown"
// text) when a value is null/absent, and only renders a badge for a real,
// non-null parsed value. If neither field has a value, the component renders
// null entirely so callers don't need their own "should I render this row"
// check.

const PETS_LABEL: Record<PetsAllowed, string> = {
  cats: "Cats OK",
  dogs: "Dogs OK",
  cats_and_dogs: "Cats & dogs OK",
  yes: "Pets OK",
  no: "No pets",
}

const LAUNDRY_LABEL: Record<LaundryType, string> = {
  in_unit: "In-unit laundry",
  hookups: "Laundry hookups",
  on_site: "On-site laundry",
}

// Falls back to a de-slugified raw value rather than silently dropping a
// real (if unrecognized) parsed value -- the value domain documented in
// lib/listingAttributes.ts is the only one the parsers produce today, but a
// badge is a safer default than hiding real data if that ever drifts.
function petsLabel(value: string): string {
  return PETS_LABEL[value as PetsAllowed] ?? value.replace(/_/g, " ")
}

function laundryLabel(value: string): string {
  return LAUNDRY_LABEL[value as LaundryType] ?? value.replace(/_/g, " ")
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-xs text-zinc-300">
      {children}
    </span>
  )
}

type ListingAttributeBadgesProps = {
  petsAllowed?: string | null
  laundryType?: string | null
  className?: string
}

export function ListingAttributeBadges({ petsAllowed, laundryType, className }: ListingAttributeBadgesProps) {
  if (!petsAllowed && !laundryType) return null

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {petsAllowed && (
        <Badge>
          <PawPrint className="w-3 h-3" aria-hidden />
          {petsLabel(petsAllowed)}
        </Badge>
      )}
      {laundryType && (
        <Badge>
          <WashingMachine className="w-3 h-3" aria-hidden />
          {laundryLabel(laundryType)}
        </Badge>
      )}
    </div>
  )
}
