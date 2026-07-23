import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'
import { parseImagesFromApartments } from '@/lib/listingImages'
import { runApifyActorAsync, type ApifyStepTools } from '@/lib/apifyAsync'

// Apartments.com listings come from an Apify actor
// (epctex/apartments-scraper-api), following the same "research + live-test
// before committing" pattern as the Craigslist/Facebook Marketplace swaps.
// memo23 (the publisher behind craigslistPoller.ts/facebookPoller.ts) has no
// Apartments.com actor - checked directly (search-actors "memo23", 10
// results, covers Realtor.com/Zillow-agents/StepStone/Trustpilot/etc, no
// Apartments.com entry) - so this source needed its own independent search
// and evaluation rather than reusing that publisher's proxy convention.
//
// Nine Apartments.com actors exist in the Apify Store as of 2026-07-17.
// epctex/apartments-scraper-api was chosen after live-testing it head-to-head
// against the next-best candidate, one-api/apartments-property-scraper:
//   - epctex: by far the highest usage (319 total / 55 monthly users) and
//     the only one with a meaningful review history (5.0/5 average across
//     11 reviews) of any Apartments.com actor in the Store - the other 8,
//     including one-api, have zero or near-zero ratings. Live-tested with a
//     real 5-item call (`search: "San Francisco, CA"`) - returned 5 real,
//     correctly geo-scoped SF properties (388 Beale, NEMA, 2000 Post, 100
//     Van Ness, The Civic) in 8.5s with real addresses, coordinates, and
//     rich per-unit data (see below). Its README doesn't explicitly
//     document residential-proxy routing the way memo23's actors do, but an
//     88.1% success rate at 319 real users across a real, correctly-scoped
//     live test was judged sufficient evidence of it actually working,
//     matching this ticket's explicit instruction to verify via a live call
//     rather than assume from the README alone.
//   - one-api/apartments-property-scraper: also live-tested (5-item call,
//     same query) and also returned correct, real SF listings - ruling out
//     an actor-quality problem for this category the way the official
//     Facebook Marketplace actor had a real region-scoping bug (see
//     facebookPoller.ts's header comment). But it's far less used (56 total
//     users, no ratings at all) and, more importantly for this poller's
//     design, only returns one flat record per *property* (a `Bed Range`/
//     `Rent Range` string like "$3,380 - 9,236", not per-unit numeric
//     values) - unlike epctex, which exposes real per-unit numeric
//     beds/baths/price/sqft via its `rentals[]` array in the same single
//     call, at no extra cost. Getting that same per-unit granularity from
//     one-api would need a second, separate detail call per property.
//
// Design - one listing row per available *unit*, not per *property*:
// Apartments.com lists professionally-managed communities ("properties"),
// each offering several floor plans and, within each floor plan, several
// specific currently-available units at their own price/availability date.
// A single property-level row with range strings ("Studio - 3 bd", "$3,936
// - $4,969") wouldn't work with this codebase's numeric price/beds/baths
// matching (`matchingEngine.ts`'s SQL range comparisons) - a $2,500-3,500
// search would trivially "match" a $3,936-9,560 property whose cheapest
// actual unit is nowhere near affordable. epctex's response already
// contains the real breakdown needed to avoid that: `property.rentals[]` -
// confirmed via the live test - is the actor's list of currently-available,
// individually-priced units (real numeric `beds`/`baths`/`basePrice`/
// `totalPrice`/`squareFeet`, a real `availableDate`, and a per-unit
// `key` used here as part of `sourceId`), as opposed to `property.models[]`
// (the property's full historical floor-plan catalog, including plans with
// zero currently-available units - not useful as "for rent right now"
// listings). This poller flattens `rentals[]` into one listing row per
// unit, so `matchingEngine.ts`'s existing numeric filters apply exactly as
// they do for the other three sources, with no changes needed there.
//
// Design - `postedAt` uses the property's `lastUpdated` (parsed), never
// `rental.availableDate`: a real mistake caught during live-testing, not
// guessed around. `availableDate` is a *move-in* date, frequently weeks or
// months in the future (e.g. one live NEMA unit had `availableDate:
// "2026-10-08"` against a same-day `lastUpdated: "3 hours ago"`) - passing
// a future date as `postedAt` would feed `lib/format.ts`'s `timeAgo()` a
// negative time delta, which its `hrs < 1` branch silently renders as "just
// now" (not a crash, but a materially wrong freshness signal on the
// dashboard map's recency-colored markers). `lastUpdated` is a per-property
// relative-time string ("2 hours ago") confirmed present and consistently
// recent across every live-tested property; `parseRelativeUpdatedAt()`
// below converts it to an approximate absolute `Date`, applied to every
// unit row flattened from that property (the field is property-level, not
// per-unit). Falls back to null (never a guess) for any format it doesn't
// recognize, same as this codebase's other "don't guess" parsers.
const APIFY_ACTOR = 'epctex~apartments-scraper-api'

// Controls the actor's own `maxItems` input, i.e. properties fetched per
// run - NOT the number of listing rows produced (each property fans out
// into several unit rows via `rentals[]`, unbilled by Apify beyond the
// property-level pricing below). Averaged ~15 available units/property
// across the 5 live-tested SF properties (10, 32, 13, 15, 5 - NEMA's large
// building skews this up), so 30 properties/run lands in the same rough
// per-run listing-row order of magnitude as craigslistPoller.ts/
// facebookPoller.ts's 80-raw-item caps once flattened, without requesting
// an excessive number of properties in one call.
const MAX_PROPERTIES_PER_RUN = 30

// Cost math (epctex's actual PAY_PER_EVENT pricing, checked via
// fetch-actor-details, not guessed): $0.01 per "List Page Query" (a page
// fetch, includes the first 20 dataset items free) + $0.0005 per "Dataset
// Item" beyond that free allotment - no optional add-ons (Get
// Reviews/Visuals/Interior Amenities/Walk Score) are enabled, so none of
// those per-event charges apply here. The live 5-item test call completed
// in 8.5s as a single fast fetch, consistent with one page comfortably
// covering more than 5 results; conservatively assuming MAX_PROPERTIES_PER_RUN
// (30) spans up to 2 page fetches ($0.02) plus up to 10 items' worth of
// Dataset Item overage beyond a 20-free allotment ($0.005) puts a single
// run at roughly $0.025. At this poller's 12-runs/day scheduled cadence
// (every 2h, matching craigslistPoller.ts/facebookPoller.ts) that's
// ~$0.30/day (~$9/month); even at the 24/day budget ceiling below (2x
// headroom for retries, same convention as the other two Apify pollers)
// worst case is ~$0.60/day - comfortably inside this project's established
// ~$1.50/day-per-poller ceiling, and notably cheaper than the runner-up
// candidate (one-api's flat $0.003/result would put the same 30-item run
// at ~$0.12, ~$1.44/day at 12 runs/day - right at the ceiling).
const UPSERT_CHUNK_SIZE = 50 // same chunked-upsert pattern as the other pollers (issue #40, PR #41)

interface ApifyApartmentsRental {
  key: string
  unitNumber?: string | null
  beds?: number | null
  baths?: number | null
  basePrice?: number | null
  totalPrice?: number | null
  squareFeet?: number | null
  availableDate?: string | null
  // Per-unit floor-plan photo - see lib/listingImages.ts's
  // parseImagesFromApartments, confirmed against a live sample run on
  // 2026-07-17. Not present on every unit (confirmed live).
  image?: string | null
  [key: string]: unknown
}

interface ApifyApartmentsProperty {
  id: string
  propertyName?: string
  url: string
  // Relative-time string ("2 hours ago") - see parseRelativeUpdatedAt below
  // for why this, not rental.availableDate, backs postedAt.
  lastUpdated?: string | null
  location?: {
    fullAddress?: string
    city?: string
    state?: string
    postalCode?: string
  } | null
  coordinates?: {
    latitude?: number | null
    longitude?: number | null
  } | null
  // The actor's list of currently-available, individually-priced units -
  // see the header comment above for why this (not `models`) is flattened.
  rentals?: ApifyApartmentsRental[] | null
  [key: string]: unknown
}

// One flattened row per available unit - the shape upsertApifyApartmentsListings
// actually consumes.
interface FlattenedApartmentsUnit {
  property: ApifyApartmentsProperty
  rental: ApifyApartmentsRental
}

function parseNumeric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parsePrice(rental: ApifyApartmentsRental): number | null {
  const price = parseNumeric(rental.totalPrice) ?? parseNumeric(rental.basePrice)
  return price !== null ? Math.round(price) : null
}

// Appends the unit number when it's a real, disclosed value - some live
// properties expose a genuine apartment number (e.g. "1231"), others mask
// it behind an internal placeholder that always starts with "N/A-" (e.g.
// "N/A-1201", confirmed on 388 Beale's live response) - masked values are
// dropped rather than shown as a nonsensical "Unit N/A-1201".
function buildUnitAddress(fullAddress: string, unitNumber: string | null | undefined): string {
  if (!unitNumber || unitNumber.startsWith('N/A')) return fullAddress
  return `${fullAddress}, Unit ${unitNumber}`
}

// See the header comment's "Design - postedAt" section. Only ever parses
// the exact "<N> <unit>(s) ago" shape confirmed live ("2 hours ago", "4
// hours ago", "3 hours ago") - returns null (never a guess) for anything
// else, e.g. "Today"/"Yesterday"/a missing field.
function parseRelativeUpdatedAt(lastUpdated: string | null | undefined, now: number): Date | null {
  if (!lastUpdated) return null
  const m = lastUpdated.match(/^(\d+)\s*(minute|hour|day|week|month)s?\s+ago$/i)
  if (!m) return null

  const amount = parseInt(m[1], 10)
  const unitMs: Record<string, number> = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000
  }
  const ms = unitMs[m[2].toLowerCase()]
  if (!ms) return null

  return new Date(now - amount * ms)
}

// Async run+poll+dataset-fetch via lib/apifyAsync.ts, not the old blocking
// run-sync-get-dataset-items endpoint - see that file's header comment for
// why. `step` must be the calling Inngest function's own step object - the
// helper makes its own step.run/step.sleep calls internally, so this can't
// be called from inside another step.run() (Inngest doesn't support
// nesting steps).
export const fetchApartmentsViaApify = (step: ApifyStepTools): Promise<ApifyApartmentsProperty[]> =>
  runApifyActorAsync<ApifyApartmentsProperty>(step, APIFY_ACTOR, {
    search: 'San Francisco, CA',
    maxItems: MAX_PROPERTIES_PER_RUN
  })

// Pure, synchronous fan-out (one property -> N unit rows) - not wrapped in
// its own step.run since it does no I/O and is cheap/deterministic, same
// reasoning as the chunk-index math in the handler below. Exported for
// direct unit testing. Properties with no currently-available units
// (missing/empty `rentals`) contribute zero rows rather than a guessed
// placeholder listing.
export function flattenApartmentsUnits(properties: ApifyApartmentsProperty[]): FlattenedApartmentsUnit[] {
  if (!Array.isArray(properties)) return []
  const units: FlattenedApartmentsUnit[] = []
  for (const property of properties) {
    const rentals = Array.isArray(property.rentals) ? property.rentals : []
    for (const rental of rentals) {
      units.push({ property, rental })
    }
  }
  return units
}

export const upsertApifyApartmentsListings = async (
  units: FlattenedApartmentsUnit[]
): Promise<{ count: number; canonicalIds: string[] }> => {
  if (!Array.isArray(units) || units.length === 0) return { count: 0, canonicalIds: [] }

  const now = Date.now()

  const values = units.map(({ property, rental }) => {
    const fullAddress = property.location?.fullAddress || 'San Francisco, CA'
    // Full property record minus the two large per-unit arrays (models are
    // this unit's siblings' floor-plan catalog, rentals are this unit's
    // siblings) - kept lean so `raw` doesn't redundantly store the same
    // multi-KB property blob once per flattened unit row, while still
    // preserving genuinely useful shared context (description, amenities,
    // schools, transportation).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { models: _models, rentals: _rentals, ...propertyRest } = property

    return {
      source: 'apartments' as const,
      sourceId: `${property.id}-${rental.key}`,
      address: buildUnitAddress(fullAddress, rental.unitNumber),
      lat: parseNumeric(property.coordinates?.latitude),
      lng: parseNumeric(property.coordinates?.longitude),
      price: parsePrice(rental),
      beds: parseNumeric(rental.beds),
      baths: parseNumeric(rental.baths),
      sqft: parseNumeric(rental.squareFeet),
      url: property.url,
      postedAt: parseRelativeUpdatedAt(property.lastUpdated, now),
      raw: { ...propertyRest, rental } as unknown as Record<string, unknown>,
      // Listing images - see lib/listingImages.ts.
      images: parseImagesFromApartments(rental)
    }
  })

  return await dedupeAndUpsertListings(values)
}

export const apartmentsPoller = inngest.createFunction(
  {
    id: 'apartments-poller',
    // Offset from craigslistPoller (0 */2) and facebookPoller (15 */2) so
    // the Apify-backed pollers don't all fire at the same minute and
    // contend for DB connections. 4 more listing-source pollers are landing
    // the same day via sibling parallel worktrees (Zumper, Apartment List,
    // Realtor.com, SpareRoom - see CLAUDE.md) picking their own offsets
    // independently; some collision across that set is possible and should
    // be checked for (via `grep -h "cron:" inngest/functions/*.ts`) once
    // all 5 have merged.
    triggers: [{ cron: '37 */2 * * *' }]
  },
  async ({ step }) => {
    const withinBudget = await step.run('check-daily-budget', () =>
      claimDailyBudget('apartments-poller', 24) // 2x the 12 scheduled runs/day, same headroom pattern as craigslistPoller.ts/facebookPoller.ts
    )
    if (!withinBudget) {
      logger.warn('Apartments.com poller skipped - daily run budget already used today')
      return { skipped: true, reason: 'daily-budget-exceeded' }
    }

    try {
      const properties = await fetchApartmentsViaApify(step)
      const units = flattenApartmentsUnits(properties)

      let upserted = 0
      const canonicalIds: string[] = []
      for (let i = 0; i < units.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = units.slice(i, i + UPSERT_CHUNK_SIZE)
        const chunkResult = await step.run(`upsert-listings-chunk-${i / UPSERT_CHUNK_SIZE}`, () =>
          upsertApifyApartmentsListings(chunk)
        )
        upserted += chunkResult.count
        canonicalIds.push(...chunkResult.canonicalIds)
      }

      if (canonicalIds.length > 0) {
        await step.sendEvent('trigger-matching', {
          name: 'app/listings.upserted',
          data: { listingIds: canonicalIds }
        })
      }

      logger.info(
        { fetchedProperties: properties.length, flattenedUnits: units.length, upserted },
        'Apartments.com (Apify) poller completed successfully'
      )

      return { fetched: units.length, upserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'Apartments.com (Apify) poller failed')
      throw error
    }
  }
)
