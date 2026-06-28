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

export const upsertCraigslistListings = async (items: CraigslistItem[]): Promise<number> => {
  if (items.length === 0) return 0

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
    try {
      let totalFetched = 0
      let totalUpserted = 0

      for (const feedUrl of CL_RSS_FEEDS) {
        const items = await step.run(`fetch-cl-${feedUrl.split('/search/')[1]?.split('/')[0] ?? 'feed'}`, () =>
          fetchCraigslistFeed(feedUrl)
        )
        const upserted = await step.run(`upsert-cl-${feedUrl.split('/search/')[1]?.split('/')[0] ?? 'feed'}`, () =>
          upsertCraigslistListings(items)
        )
        totalFetched += items.length
        totalUpserted += upserted
      }

      logger.info(
        { fetched: totalFetched, upserted: totalUpserted, feeds: CL_RSS_FEEDS.length },
        'Craigslist poller completed successfully'
      )

      return { fetched: totalFetched, upserted: totalUpserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'Craigslist poller failed')
      throw error
    }
  }
)
