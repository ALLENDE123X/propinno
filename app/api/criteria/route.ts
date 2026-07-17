import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { criteria } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'
import { computeCommuteIsochrone, type CommuteMode } from '@/lib/commute'
import * as Sentry from '@sentry/nextjs'

// AH-026. GET returns the current user's saved criteria (competitive parity
// with AH3000's "Search Profile" section - see docs/AH3000_teardown.md); PATCH
// updates it. Same active-session auth gate as every other authenticated
// listing/inbox/favourites route (lib/session.ts's getActiveSessionUser()).
//
// Every field is nullable on write, unlike POST /api/auth/verify-otp's
// onboarding schema (which only ever *adds* criteria a brand-new user didn't
// have yet, so omitting a field there just means "not set"). This is an edit
// surface - a subscriber must be able to explicitly clear a previously-set
// preference (e.g. remove a pets requirement they no longer have), so a field
// present with `null` means "clear it" and a field entirely absent from the
// PATCH body means "leave it untouched", matching verify-otp's existing
// omit-undefined-keys convention for building the SQL SET clause (Postgres
// rejects an empty SET, so keys are filtered to only those actually present).
const patchCriteriaSchema = z.object({
  priceMin: z.coerce.number().nullable().optional(),
  priceMax: z.coerce.number().nullable().optional(),
  bedsMin: z.coerce.number().nullable().optional(),
  bedsMax: z.coerce.number().nullable().optional(),
  // AH-024. Same real (not int) type as bedsMin/bedsMax - see
  // lib/db/schema.ts's criteria.bathsMin/bathsMax comment.
  bathsMin: z.coerce.number().nullable().optional(),
  bathsMax: z.coerce.number().nullable().optional(),
  zips: z.array(z.string()).nullable().optional(),
  neighborhoods: z.array(z.string()).nullable().optional(),
  // Same value domain as verify-otp's criteria schema - kept in sync with
  // components/criteria-form-fields.tsx's <select> options.
  pets: z.enum(['cats', 'dogs', 'cats_and_dogs']).nullable().optional(),
  laundry: z.enum(['in_unit', 'on_site']).nullable().optional(),
  commuteAddress: z.string().min(1).max(200).nullable().optional(),
  commuteMaxMinutes: z.coerce.number().int().min(1).max(180).nullable().optional(),
  commuteMode: z.enum(['transit', 'bike', 'drive']).nullable().optional(),
})

// GET the current user's full criteria row for the search-profile edit form
// (components/search-profile-form.tsx) to pre-fill from. Defensively
// defaults to an all-null shape if no row exists yet (shouldn't happen -
// verify-otp always inserts a criteria row, even an empty one - but an
// active user with no row would otherwise 500 instead of just seeing a blank
// form).
export async function GET(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`criteria-get-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const auth = await getActiveSessionUser()
    if (!auth.ok) {
      const { error, status } = sessionErrorResponse(auth.status)
      return NextResponse.json({ error }, { status })
    }

    const [row] = await db
      .select({
        priceMin: criteria.priceMin,
        priceMax: criteria.priceMax,
        bedsMin: criteria.bedsMin,
        bedsMax: criteria.bedsMax,
        bathsMin: criteria.bathsMin,
        bathsMax: criteria.bathsMax,
        zips: criteria.zips,
        neighborhoods: criteria.neighborhoods,
        pets: criteria.pets,
        laundry: criteria.laundry,
        commuteAddress: criteria.commuteAddress,
        commuteMaxMinutes: criteria.commuteMaxMinutes,
        commuteMode: criteria.commuteMode,
      })
      .from(criteria)
      .where(eq(criteria.userId, auth.userId))

    return NextResponse.json({
      criteria: row ?? {
        priceMin: null,
        priceMax: null,
        bedsMin: null,
        bedsMax: null,
        bathsMin: null,
        bathsMax: null,
        zips: null,
        neighborhoods: null,
        pets: null,
        laundry: null,
        commuteAddress: null,
        commuteMaxMinutes: null,
        commuteMode: null,
      },
    })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to fetch criteria')
    return NextResponse.json({ error: 'Failed to load your search profile' }, { status: 500 })
  }
}

// PATCH updates the current user's criteria. Only the commute isochrone
// recompute (AH-017's computeCommuteIsochrone(), the same function
// POST /api/auth/verify-otp calls at onboarding time) is conditional -
// everything else is a plain field write. The isochrone is only recomputed
// when commuteAddress/commuteMode/commuteMaxMinutes actually changed in this
// request (compared against the row's current values, fetched first) -
// never on every save - so editing an unrelated field like priceMax doesn't
// burn a Mapbox Isochrone API call. See lib/commute.ts's header comment for
// why this cache exists at all.
export async function PATCH(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`criteria-patch-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const auth = await getActiveSessionUser()
    if (!auth.ok) {
      const { error, status } = sessionErrorResponse(auth.status)
      return NextResponse.json({ error }, { status })
    }

    const body = await req.json().catch(() => null)
    const parsed = patchCriteriaSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    // Only keys actually present in the request body - an empty Postgres SET
    // clause is a syntax error, and "absent" must mean "don't touch" (see
    // header comment), not "clear".
    const updates: Record<string, unknown> = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined)
    )

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields provided to update' }, { status: 400 })
    }

    const [current] = await db
      .select({
        commuteAddress: criteria.commuteAddress,
        commuteMode: criteria.commuteMode,
        commuteMaxMinutes: criteria.commuteMaxMinutes,
      })
      .from(criteria)
      .where(eq(criteria.userId, auth.userId))

    const commuteAddressChanged = 'commuteAddress' in updates && updates.commuteAddress !== (current?.commuteAddress ?? null)
    const commuteModeChanged = 'commuteMode' in updates && updates.commuteMode !== (current?.commuteMode ?? null)
    const commuteMaxMinutesChanged = 'commuteMaxMinutes' in updates && updates.commuteMaxMinutes !== (current?.commuteMaxMinutes ?? null)
    const commuteFieldsChanged = commuteAddressChanged || commuteModeChanged || commuteMaxMinutesChanged

    let commuteRecomputed = false
    if (commuteFieldsChanged) {
      const effectiveAddress = ('commuteAddress' in updates ? updates.commuteAddress : current?.commuteAddress ?? null) as string | null
      const effectiveMode = ('commuteMode' in updates ? updates.commuteMode : current?.commuteMode ?? null) as CommuteMode | null
      const effectiveMaxMinutes = ('commuteMaxMinutes' in updates ? updates.commuteMaxMinutes : current?.commuteMaxMinutes ?? null) as number | null

      if (effectiveAddress && effectiveMode && effectiveMaxMinutes) {
        const isochrone = await computeCommuteIsochrone({
          address: effectiveAddress,
          mode: effectiveMode,
          maxMinutes: effectiveMaxMinutes,
        })
        if (!isochrone) {
          logger.warn(
            { userId: auth.userId, address: effectiveAddress, mode: effectiveMode },
            'Commute isochrone could not be recomputed after a search-profile edit; commute filter will not apply until recomputed'
          )
        }
        updates.commuteIsochrone = isochrone
        commuteRecomputed = true
      } else {
        // One of the three commute fields is now missing (e.g. the user
        // cleared their work address) - disable the filter directly rather
        // than calling Mapbox with an incomplete input.
        updates.commuteIsochrone = null
        commuteRecomputed = true
      }
    }

    // Upsert (not a plain UPDATE) as a defensive fallback in case this user
    // somehow has no criteria row yet - every active user should have one
    // (verify-otp always inserts one, even empty), but this mirrors
    // verify-otp's own insert().onConflictDoUpdate() pattern rather than
    // assuming the row exists.
    await db
      .insert(criteria)
      .values({ userId: auth.userId, ...updates })
      .onConflictDoUpdate({ target: criteria.userId, set: updates })

    logger.info({ userId: auth.userId, fields: Object.keys(updates), commuteRecomputed }, 'Search profile criteria updated')
    return NextResponse.json({ success: true, commuteRecomputed })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to update criteria')
    return NextResponse.json({ error: 'Failed to save your search profile' }, { status: 500 })
  }
}
