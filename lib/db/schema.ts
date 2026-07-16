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
  raw: jsonb('raw')
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
