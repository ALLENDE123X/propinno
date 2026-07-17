// Listing image URL parsing, shared by all pollers so
// inngest/functions/rentcastPoller.ts, inngest/functions/craigslistPoller.ts,
// and inngest/functions/facebookPoller.ts stay thin mapping layers and the
// parsing logic has one tested home - same pattern as
// lib/listingAttributes.ts's pet/laundry parsers (AH-018).
//
// Each source returns image data in a different shape - checked against real
// data before writing any of this, not guessed:
//
//   - RentCast (`/v1/listings/rental/long-term`): NO image data at all.
//     Confirmed against every key present across all 895 live production
//     rows (`jsonb_object_keys(raw)` - address/price/beds/baths/sqft/
//     property type/listing history/MLS info only, same shape AH-018 already
//     found for pets/laundry) AND a fresh live API call directly against
//     RentCast (2026-07-17, 2 listings, identical field set, no photo/image
//     key anywhere). parseImagesFromRentcast is a real, tested extension
//     point in case a future RentCast plan/endpoint adds photos - not dead
//     code - but it always returns [] today.
//   - Craigslist (memo23/craigslist-scraper Apify actor): `pics` is a flat
//     array of ready-to-use direct image URL strings, e.g.
//     "https://images.craigslist.org/00O0O_7jErhjDdqjs_0sX0CI_600x450.jpg".
//     Confirmed via a live 3-item actor call (2026-07-17) - the simplest of
//     the three shapes, no normalization needed beyond filtering to strings.
//   - Facebook Marketplace (memo23/facebook-marketplace-scraper-ppe Apify
//     actor): two separate fields, confirmed via a live 3-item actor call
//     with includeSeller:true (2026-07-17) - `primary_listing_photo.photo_image_url`
//     (single cover photo, always present) and
//     `moreDetails.listing_photos[].image.uri` (the full gallery - one live
//     listing had 14 photos, with the primary photo already present as the
//     gallery's first element). The gallery is preferred when present since
//     it's a strict superset; primary_listing_photo is only a fallback for
//     the (untested-live but plausible) case where moreDetails is absent.
//     Facebook's CDN URLs are signed/expiring (`oe=` query param) - unlike
//     Craigslist/RentCast, these will eventually 404. Accepted tradeoff of
//     linking Facebook's own CDN rather than re-hosting images ourselves;
//     same "link out, don't proxy" approach this codebase already takes for
//     `url` (the outbound listing link).
//   - Apartments.com (epctex/apartments-scraper-api Apify actor): confirmed
//     via a live 5-item actor call against "San Francisco, CA" (2026-07-17).
//     apartmentsPoller.ts flattens each scraped *property* (an apartment
//     community with many floor plans) into one listing row per currently
//     available *unit* (`property.rentals[]` - see that poller's header
//     comment for why), and each unit sub-object carries its own `image`
//     field: a single real floor-plan photo URL (images1.apartments.com
//     CDN). This is the free default shape - a fuller interior/exterior
//     gallery exists behind the actor's paid `includeVisuals` option, not
//     enabled here (not needed for a real photo per unit, and keeps cost
//     down - see apartmentsPoller.ts's cost-math comment). `image` is
//     present on most but not all rentals within a live property response
//     (confirmed live - several units on one real "100 Van Ness" test
//     result had no `image` field at all), so this always degrades to `[]`
//     rather than guessing.
//   - Apartment List (solidcode/apartmentlist-com-scraper Apify actor, run
//     with includeDetails:true): two separate photo arrays, confirmed via a
//     live 2-property SF call (2026-07-17) - the top-level `photos` field is
//     the property's full community/building gallery (30-40 real photos
//     observed per property), and each entry in the property's `units[]`
//     array has its own `photos` field (observed as exactly one real
//     floorplan/unit photo per unit). apartmentListPoller.ts explodes one
//     property into one listing per live (priced + available) unit, so the
//     specific unit's own photo is the most relevant image for that exact
//     listing and is ordered first; the property's wider gallery is appended
//     after as supplementary context. Direct, unsigned `cdn.apartmentlist.com`
//     URLs - no expiry concern like Facebook's signed CDN links.
//   - Zumper (benthepythondev/zumper-rental-scraper Apify actor): confirmed
//     via two live search-mode calls against san-francisco-ca (2026-07-17,
//     `includePhotos: true`) - the actor only exposes `image_ids` (a flat
//     array of opaque numeric Zumper internal photo IDs, e.g. `761884337`),
//     never a resolvable image URL of any kind, in either its default
//     "search" mode or a follow-up "direct_urls" detail-page call against one
//     of the same live listing URLs (which returned 0 dataset items,
//     ruling out the enrichment path too). No public, documented Zumper CDN
//     URL pattern was found to reconstruct a real URL from just an ID, and
//     this codebase's convention (see RentCast above) is to never guess at a
//     URL rather than link something that might not resolve.
//     parseImagesFromZumper is a real, tested extension point in case a
//     future actor version/mode adds real photo URLs - not dead code - but
//     it always returns [] today, same rationale as parseImagesFromRentcast.

// Parameter kept (even though unused today) so the signature matches the
// other two parsers and stays a real, callable extension point - see the
// header comment above for why RentCast never has image data to parse.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function parseImagesFromRentcast(raw: Record<string, unknown>): string[] {
  return []
}

export function parseImagesFromCraigslist(item: { pics?: unknown }): string[] {
  return normalizeUrlArray(item.pics)
}

// Parameter kept (even though unused today) so the signature matches the
// other parsers and stays a real, callable extension point - see the header
// comment above for why Zumper's actor never has a resolvable image URL.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function parseImagesFromZumper(item: { image_ids?: unknown }): string[] {
  return []
}

export function parseImagesFromFacebook(item: {
  primary_listing_photo?: { photo_image_url?: unknown } | null
  moreDetails?: { listing_photos?: unknown } | null
}): string[] {
  const rawGallery = item.moreDetails?.listing_photos
  const gallery = Array.isArray(rawGallery)
    ? normalizeUrlArray(
        (rawGallery as unknown[]).map(
          (photo) => (photo as { image?: { uri?: unknown } } | null)?.image?.uri
        )
      )
    : []
  if (gallery.length > 0) return gallery

  const primary = item.primary_listing_photo?.photo_image_url
  return typeof primary === 'string' && primary.length > 0 ? [primary] : []
}

export function parseImagesFromApartments(rental: { image?: unknown }): string[] {
  return normalizeUrlArray([rental.image])
}

export function parseImagesFromApartmentList(listing: {
  unitPhotos?: unknown
  propertyPhotos?: unknown
}): string[] {
  const unitPhotos = normalizeUrlArray(listing.unitPhotos)
  const propertyPhotos = normalizeUrlArray(listing.propertyPhotos)
  if (unitPhotos.length === 0) return propertyPhotos
  return normalizeUrlArray([...unitPhotos, ...propertyPhotos])
}

/**
 * Filters to non-empty strings and de-dupes while preserving order - shared
 * by the parsers above. Never throws on malformed input (missing field,
 * wrong type, non-string entries); anything that isn't a usable URL is
 * dropped rather than guessed at.
 */
function normalizeUrlArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const urls = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return Array.from(new Set(urls))
}
