import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'

// Craigslist sfbay apartment RSS feeds — split by sub-region to work around
// the 120-item per-feed cap. RSS is the lower-risk path (vs HTML scraping);
// ToS technically prohibits automated access, but RSS is a published data
// format explicitly intended for syndication. We use it as-is with no auth
// bypass, no session spoofing, no HTML parsing.
const CL_RSS_FEEDS = [
  'https://sfbay.craigslist.org/search/sfc/apa?format=rss', // SF city
  'https://sfbay.craigslist.org/search/eby/apa?format=rss', // East Bay
  'https://sfbay.craigslist.org/search/nby/apa?format=rss', // North Bay
  'https://sfbay.craigslist.org/search/pen/apa?format=rss', // Peninsula
  'https://sfbay.craigslist.org/search/sby/apa?format=rss', // South Bay
]

interface CraigslistItem {
  guid: string
  title: string
  link: string
  price: number | null
  address: string
  postedAt: Date | string | null
  beds: number | null
  raw: Record<string, unknown>
}

/** Extract text content from a simple XML tag (no namespace). */
function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''
}

/** Parse price like "$3,200 / 2br" → 3200, or null if not parseable. */
function parsePrice(title: string): number | null {
  const m = title.match(/\$([0-9,]+)/)
  if (!m) return null
  return parseInt(m[1].replace(/,/g, ''), 10)
}

/** Parse bed count like "2br" → 2, or null. */
function parseBeds(title: string): number | null {
  const m = title.match(/(\d+(?:\.\d+)?)\s*br/i)
  return m ? parseFloat(m[1]) : null
}

export const fetchCraigslistFeed = async (url: string): Promise<CraigslistItem[]> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Propinno-RSS-Reader/1.0 (+https://propinno.com)' }
  })

  if (!res.ok) {
    throw new Error(`Craigslist RSS ${url} returned ${res.status}`)
  }

  const xml = await res.text()
  const items: CraigslistItem[] = []

  // Split on <item> tags
  const itemBlocks = xml.split('<item>').slice(1)
  for (const block of itemBlocks) {
    const endIdx = block.indexOf('</item>')
    const itemXml = endIdx >= 0 ? block.slice(0, endIdx) : block

    const guid = extractTag(itemXml, 'guid')
    const title = extractTag(itemXml, 'title')
    const link = extractTag(itemXml, 'link') || guid
    const pubDate = extractTag(itemXml, 'pubDate')
    const description = extractTag(itemXml, 'description')

    if (!guid || !title) continue

    items.push({
      guid,
      title,
      link,
      price: parsePrice(title),
      address: title.replace(/^\$[\d,]+\s*\/?\s*\d*br\s*-?\s*/i, '').trim() || 'SF Bay Area, CA',
      postedAt: pubDate ? new Date(pubDate) : null,
      beds: parseBeds(title),
      raw: { guid, title, link, pubDate, description }
    })
  }

  return items
}

export const upsertCraigslistListings = async (items: CraigslistItem[]): Promise<{ count: number, canonicalIds: string[] }> => {
  if (items.length === 0) return { count: 0, canonicalIds: [] }

  const values = items.map((l) => ({
    source: 'craigslist' as const,
    sourceId: l.guid,
    address: l.address,
    lat: null,
    lng: null,
    price: l.price,
    beds: l.beds,
    baths: null,
    sqft: null,
    url: l.link,
    postedAt: l.postedAt ? new Date(l.postedAt) : null,
    raw: l.raw
  }))

  return await dedupeAndUpsertListings(values)
}

export const craigslistPoller = inngest.createFunction(
  {
    id: 'craigslist-poller',
    triggers: [{ cron: '*/15 * * * *' }]
  },
  async ({ step }) => {
    let totalFetched = 0
    let totalUpserted = 0
    const allCanonicalIds: string[] = []
    const feedErrors: string[] = []

    // Each region is isolated: one blocked/broken feed must not prevent the
    // other four from being attempted. Previously a single throw here
    // aborted the whole function immediately (always on the first feed,
    // "sfc"), meaning zero regions - not just the failing one - ever got
    // polled once any region started failing.
    for (const feedUrl of CL_RSS_FEEDS) {
      const region = feedUrl.split('/search/')[1]?.split('/')[0] ?? 'feed'
      try {
        const items = await step.run(`fetch-cl-${region}`, () => fetchCraigslistFeed(feedUrl))
        const result = await step.run(`upsert-cl-${region}`, () => upsertCraigslistListings(items))
        totalFetched += items.length
        totalUpserted += result.count
        if (result.canonicalIds) {
          allCanonicalIds.push(...result.canonicalIds)
        }
      } catch (error) {
        feedErrors.push(`${region}: ${error instanceof Error ? error.message : String(error)}`)
        Sentry.captureException(error)
        logger.error({ err: error, region }, 'Craigslist feed failed, continuing to next region')
      }
    }

    if (allCanonicalIds.length > 0) {
      await step.sendEvent('trigger-matching', {
        name: 'app/listings.upserted',
        data: { listingIds: allCanonicalIds }
      })
    }

    logger.info(
      { fetched: totalFetched, upserted: totalUpserted, feeds: CL_RSS_FEEDS.length, failedFeeds: feedErrors.length },
      'Craigslist poller completed'
    )

    if (feedErrors.length === CL_RSS_FEEDS.length) {
      // Every single region failed - a real, actionable problem (the whole
      // RSS format being blocked, say) rather than one flaky feed. Surface
      // it as a genuine failure so it's still visible, just not 5x noisier
      // than it needs to be.
      throw new Error(`All Craigslist feeds failed: ${feedErrors.join('; ')}`)
    }

    return { fetched: totalFetched, upserted: totalUpserted, failedFeeds: feedErrors }
  }
)
