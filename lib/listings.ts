import { db } from '@/lib/db'
import { listings } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'
import { logger } from '@/lib/logger'

export async function geocode(address: string): Promise<{ lat: number, lng: number } | null> {
  const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN
  if (!MAPBOX_TOKEN || !address) return null
  
  try {
    let addressQuery = address
    if (!addressQuery.toLowerCase().includes('ca') && !addressQuery.toLowerCase().includes('california')) {
      addressQuery += ', San Francisco Bay Area, CA'
    }
    const endpoint = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(addressQuery)}.json?access_token=${MAPBOX_TOKEN}&limit=1`
    const res = await fetch(endpoint)
    if (!res.ok) return null
    
    const data = await res.json()
    const feature = data.features?.[0]
    if (!feature?.center) return null
    
    return {
      lng: feature.center[0],
      lat: feature.center[1]
    }
  } catch (err) {
    logger.error({ err }, 'Geocoding failed')
    return null
  }
}

export async function dedupeAndUpsertListings(
  items: {
    source: 'rentcast' | 'craigslist' | 'facebook'
    sourceId: string
    address: string
    lat: number | null
    lng: number | null
    price: number | null
    beds: number | null
    baths: number | null
    sqft: number | null
    url: string | null
    postedAt: Date | null
    raw: unknown
    // AH-018, optional so existing/test callers that don't parse pet/laundry
    // data don't need updating - omitted or undefined behaves the same as
    // null (matching engine treats null as "unknown, don't filter on it").
    petsAllowed?: string | null
    laundryType?: string | null
  }[]
) {
  let count = 0
  const upsertedCanonicalIds: string[] = []
  
  for (const item of items) {
    let { lat, lng } = item
    
    // Geocode if missing lat/lng
    if (!lat || !lng) {
      const geo = await geocode(item.address)
      if (geo) {
        lat = geo.lat
        lng = geo.lng
      }
    }

    // Dedupe
    let isCanonical = true
    let canonicalId: string | null = null

    if (lat && lng && item.price) {
      // Find existing canonical listing within ~50m and same price
      // ~50m is approx 0.00045 degrees. Squared threshold is ~0.0000002
      const duplicateRes = await db.execute(sql`
        SELECT id FROM listings
        WHERE is_canonical = true
          AND price = ${item.price}
          AND lat IS NOT NULL AND lng IS NOT NULL
          AND POWER(lat - ${lat}, 2) + POWER((lng - ${lng}) * 0.78, 2) <= 0.0000002
        LIMIT 1
      `) as { id: string }[]
      
      if (duplicateRes && duplicateRes.length > 0) {
        isCanonical = false
        canonicalId = duplicateRes[0].id
      }
    }

    const res = await db.insert(listings).values({
      source: item.source,
      sourceId: item.sourceId,
      address: item.address,
      lat,
      lng,
      price: item.price,
      beds: item.beds,
      baths: item.baths,
      sqft: item.sqft,
      url: item.url,
      postedAt: item.postedAt,
      isCanonical,
      canonicalId,
      raw: item.raw,
      petsAllowed: item.petsAllowed,
      laundryType: item.laundryType
    }).onConflictDoUpdate({
      target: [listings.source, listings.sourceId],
      set: {
        price: sql`EXCLUDED.price`,
        url: sql`EXCLUDED.url`,
        raw: sql`EXCLUDED.raw`,
        postedAt: sql`EXCLUDED.posted_at`,
        lat: sql`EXCLUDED.lat`,
        lng: sql`EXCLUDED.lng`,
        petsAllowed: sql`EXCLUDED.pets_allowed`,
        laundryType: sql`EXCLUDED.laundry_type`
      }
    }).returning({ id: listings.id, isCanonical: listings.isCanonical })
    
    if (res[0]?.isCanonical) {
      upsertedCanonicalIds.push(res[0].id)
    }
    count++
  }
  return { count, canonicalIds: upsertedCanonicalIds }
}
