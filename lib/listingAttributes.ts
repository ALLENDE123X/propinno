// AH-018 pet-policy and laundry-type parsing, shared by both pollers so
// inngest/functions/rentcastPoller.ts and inngest/functions/craigslistPoller.ts
// stay thin mapping layers and the parsing logic has one tested home.
//
// Value domains (kept as plain string unions, not a Drizzle pgEnum - see
// lib/db/schema.ts for why):
//   PetsAllowed:  'cats' | 'dogs' | 'cats_and_dogs' | 'yes' | 'no' | null
//   LaundryType:  'in_unit' | 'hookups' | 'on_site' | null
//
// null always means "couldn't determine this from the source data" - never
// a guess at "no pets" or "no laundry". Only Craigslist's free-text fallback
// (parsePetsFromText's "no pets" branch) ever produces the negative 'no'
// value; everything else either finds a positive signal or returns null.

export type PetsAllowed = 'cats' | 'dogs' | 'cats_and_dogs' | 'yes' | 'no'
export type LaundryType = 'in_unit' | 'hookups' | 'on_site'

/**
 * RentCast's `/v1/listings/rental/long-term` response (the only endpoint
 * rentcastPoller.ts calls) does not include any pet-policy field - confirmed
 * empirically against all 801 live rows in production as of 2026-07-16 (no
 * key or nested value anywhere in `raw` matches /pet|dog|cat|laundry|washer|dryer/i
 * across the full response shape: address/price/beds/baths/sqft/property
 * type/listing history/MLS info only). This function is a real, tested
 * extension point in case RentCast adds the data or a future plan/endpoint
 * exposes it - not dead code - but for now it always returns null rather
 * than guessing at undocumented field names.
 */
export function parsePetsFromRentcast(raw: Record<string, unknown>): PetsAllowed | null {
  const candidate = raw.petsAllowed ?? raw.petPolicy ?? raw.pets
  if (typeof candidate === 'string') {
    return normalizePetsFromText(candidate)
  }
  return null
}

/**
 * Same rationale as parsePetsFromRentcast - no laundry field present in any
 * live RentCast row today. Real extension point, not dead code.
 */
export function parseLaundryFromRentcast(raw: Record<string, unknown>): LaundryType | null {
  const candidate = raw.laundryType ?? raw.laundry
  if (typeof candidate === 'string') {
    return normalizeLaundryFromText(candidate)
  }
  return null
}

/**
 * The Apify actor (memo23/craigslist-scraper) normalizes Craigslist's own
 * housing checkboxes into a structured `amenities` string array - e.g.
 * `["cats are OK - purrr", "dogs are OK - wooof", "w/d in unit"]` - confirmed
 * against a live sample run (2026-07-16). That's a far more reliable signal
 * than regexing the free-text title/body, so it's checked first; the
 * title/post text regex (closer to the issue's originally suggested
 * approach) is only a fallback for listings where the poster didn't tick the
 * corresponding Craigslist checkbox but mentioned it in the description.
 */
export function parsePetsFromCraigslist(item: {
  amenities?: unknown
  title?: string | null
  post?: string | null
}): PetsAllowed | null {
  const amenities = Array.isArray(item.amenities) ? (item.amenities as unknown[]) : []
  const catsOk = amenities.some((a) => typeof a === 'string' && /^cats?\s+are\s+ok/i.test(a))
  const dogsOk = amenities.some((a) => typeof a === 'string' && /^dogs?\s+are\s+ok/i.test(a))

  if (catsOk && dogsOk) return 'cats_and_dogs'
  if (catsOk) return 'cats'
  if (dogsOk) return 'dogs'

  const text = `${item.title ?? ''} ${item.post ?? ''}`
  return normalizePetsFromText(text)
}

export function parseLaundryFromCraigslist(item: {
  amenities?: unknown
  title?: string | null
  post?: string | null
}): LaundryType | null {
  const amenities = Array.isArray(item.amenities) ? (item.amenities as unknown[]) : []
  const stringAmenities = amenities.filter((a): a is string => typeof a === 'string')

  if (stringAmenities.some((a) => /w\/?d\s*in\s*unit/i.test(a))) return 'in_unit'
  if (stringAmenities.some((a) => /w\/?d\s*hook.?ups?/i.test(a))) return 'hookups'
  if (stringAmenities.some((a) => /laundry\s*(in\s*bldg|on\s*.?site)/i.test(a))) return 'on_site'

  const text = `${item.title ?? ''} ${item.post ?? ''}`
  return normalizeLaundryFromText(text)
}

/**
 * Free-text fallback shared by the RentCast defensive path and Craigslist's
 * amenities-miss fallback. Only assigns a value when a specific pattern
 * actually matches - never a default guess.
 */
function normalizePetsFromText(text: string): PetsAllowed | null {
  if (/no\s*pets?\b/i.test(text)) return 'no'
  if (/\bpets?\s*(ok|okay|allowed|friendly|welcome)\b/i.test(text)) return 'yes'
  return null
}

function normalizeLaundryFromText(text: string): LaundryType | null {
  if (/w\/?d\s*in\s*unit|in.?unit\s*w\/?d|washer.{0,10}dryer.{0,10}in.?unit/i.test(text)) return 'in_unit'
  if (/w\/?d\s*hook.?ups?|washer.{0,10}dryer.{0,10}hook.?ups?/i.test(text)) return 'hookups'
  if (/laundry.{0,20}(on.?site|in\s*bldg|in\s*building)|on.?site.{0,20}laundry|laundry\s*room|coin.?op(erated)?\s*laundry/i.test(text)) return 'on_site'
  return null
}
