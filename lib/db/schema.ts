import {
  pgTable,
  uuid,
  text,
  timestamp,
  time,
  pgEnum,
  unique,
  real,
  integer,
  boolean,
  jsonb,
  index
} from 'drizzle-orm/pg-core'

export const userStatusEnum = pgEnum('user_status', ['pending_payment', 'active', 'expired', 'done'])
export const userPlanEnum = pgEnum('user_plan', ['pass_30', 'pass_90'])

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  phone: text('phone').notNull().unique(),
  status: userStatusEnum('status').notNull().default('pending_payment'),
  plan: userPlanEnum('plan'),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // AH-019 notification preferences. Quiet hours are wall-clock time-of-day
  // (no date/timezone component) evaluated against America/Los_Angeles at
  // send time — see inngest/functions/twilioSender.ts. Defaults (21:00-08:00,
  // cap 20/day, not paused) are chosen so existing users get a reasonable
  // "don't text me overnight" behavior without silently going unlimited
  // (null) or silently going to zero (blocked).
  quietStart: time('quiet_start').notNull().default('21:00:00'),
  quietEnd: time('quiet_end').notNull().default('08:00:00'),
  maxDailySms: integer('max_daily_sms').notNull().default(20),
  notificationsPaused: boolean('notifications_paused').notNull().default(false),
})

export const listings = pgTable('listings', {
  id: uuid('id').defaultRandom().primaryKey(),
  source: text('source').notNull(),
  sourceId: text('source_id').notNull(),
  address: text('address').notNull(),
  lat: real('lat'),
  lng: real('lng'),
  price: integer('price'),
  beds: real('beds'),
  baths: real('baths'),
  sqft: integer('sqft'),
  url: text('url'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  isCanonical: boolean('is_canonical').default(false).notNull(),
  canonicalId: uuid('canonical_id'),
  raw: jsonb('raw'),
  // AH-018 pet policy and laundry type, parsed per-source at poll time (see
  // lib/listingAttributes.ts). Plain text rather than a pgEnum since the
  // value domain is source-parsing-derived and may grow; null means "not
  // parseable from this listing's data", not "no pets"/"no laundry" - the
  // matching engine treats null as non-disqualifying (see matchingEngine.ts).
  // petsAllowed: 'cats' | 'dogs' | 'cats_and_dogs' | 'yes' | 'no' | null
  // laundryType: 'in_unit' | 'hookups' | 'on_site' | null
  petsAllowed: text('pets_allowed'),
  laundryType: text('laundry_type'),
  // AH-023 nearby-amenity cache (grocery/gym/transit/bike-share), computed
  // lazily the first time a listing's detail card is opened (see
  // lib/amenities.ts's computeNearbyAmenities() and
  // app/api/listings/[listingId]/amenities/route.ts) - never recomputed on
  // every pageview, since a listing's address/nearby POIs don't change.
  // Deliberately untyped jsonb (matches raw/commuteIsochrone's existing
  // convention in this schema) - callers cast the shape explicitly via
  // lib/amenities.ts's exported ListingAmenitiesCache type. Null means "not
  // computed yet" (never viewed) - distinct from an empty `amenities: []`
  // array, which means "computed successfully, nothing found nearby".
  amenities: jsonb('amenities')
}, (table) => [
  unique('listings_source_source_id_unique').on(table.source, table.sourceId),
  index('listings_geo_idx').on(table.lat, table.lng),
])

export const criteria = pgTable('criteria', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).primaryKey(),
  priceMin: integer('price_min'),
  priceMax: integer('price_max'),
  bedsMin: real('beds_min'),
  bedsMax: real('beds_max'),
  zips: text('zips').array(),
  neighborhoods: text('neighborhoods').array(),
  // AH-018 subscriber pet/laundry requirements, optional (null = no
  // preference, matched by the matching engine's null-passthrough filter
  // pattern - see matchingEngine.ts). Domains intentionally narrower than
  // listings.petsAllowed/laundryType since a subscriber states a need, not
  // an observed value: pets: 'cats' | 'dogs' | 'cats_and_dogs' | null;
  // laundry: 'in_unit' | 'on_site' | null.
  pets: text('pets'),
  laundry: text('laundry'),
  // AH-017 commute-time filtering. commuteAddress/commuteMaxMinutes/commuteMode
  // are the subscriber's raw input (all null = no commute filter set).
  // commuteMode: 'transit' | 'bike' | 'drive'. commuteIsochrone is a CACHED
  // result, computed once (via lib/commute.ts's computeCommuteIsochrone())
  // whenever the three fields above are set/changed - never recomputed per
  // match. Deliberately untyped jsonb (matches listings.raw's existing
  // convention in this schema) rather than `.$type<...>()`; callers cast the
  // shape explicitly, see lib/commute.ts's CommuteIsochroneCache type. Null
  // means "no commute filter, or isochrone computation failed" - both are
  // non-disqualifying via the same null-passthrough pattern as pets/laundry.
  // IMPORTANT: Mapbox's Isochrone API has no transit/public-transit profile
  // (driving/walking/cycling only) - 'transit' mode is an explicitly-labeled
  // APPROXIMATION, not real transit routing. See lib/commute.ts header comment.
  commuteAddress: text('commute_address'),
  commuteMaxMinutes: integer('commute_max_minutes'),
  commuteMode: text('commute_mode'),
  commuteIsochrone: jsonb('commute_isochrone'),
})

export const sent = pgTable('sent', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  listingId: uuid('listing_id').notNull().references(() => listings.id, { onDelete: 'cascade' }),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  // Null = unread/not dismissed. Set to the action timestamp when the user
  // reads or dismisses the item in the in-app inbox (AH-016). Two separate
  // nullable timestamps (rather than booleans) so we keep a record of *when*
  // each action happened, matching this schema's existing convention
  // (sentAt/firstSeenAt/postedAt) of timestamp-as-event-marker over boolean flags.
  readAt: timestamp('read_at', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
}, (table) => [
  unique('sent_user_id_listing_id_unique').on(table.userId, table.listingId)
])

// AH-022 saved/bookmarked listings, deliberately the same shape/conventions
// as `sent` above: userId + listingId (both FK ON DELETE CASCADE) + a single
// event-marker timestamp, unique(userId, listingId) so re-saving an
// already-saved listing is idempotent at the DB level (callers use
// onConflictDoNothing() on insert, same pattern twilioSender.ts already uses
// for `sent`) rather than needing a SELECT-then-INSERT race-prone check.
export const favourites = pgTable('favourites', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  listingId: uuid('listing_id').notNull().references(() => listings.id, { onDelete: 'cascade' }),
  savedAt: timestamp('saved_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('favourites_user_id_listing_id_unique').on(table.userId, table.listingId)
])
