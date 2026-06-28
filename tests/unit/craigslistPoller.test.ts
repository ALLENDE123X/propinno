import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchCraigslistFeed, upsertCraigslistListings } from '@/inngest/functions/craigslistPoller'

const mockReturning = vi.fn().mockResolvedValue([{ id: '1', isCanonical: true }])
const mockOnConflictDoUpdate = vi.fn().mockReturnValue({ returning: mockReturning })
const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate })
const mockInsert = vi.fn().mockReturnValue({ values: mockValues })

vi.mock('@/lib/db', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    execute: vi.fn().mockResolvedValue([])
  }
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() }
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SF apts</title>
    <item>
      <guid>https://sfbay.craigslist.org/sfc/apa/1234567890.html</guid>
      <title>$3,200 / 2br - Nice flat in Mission</title>
      <link>https://sfbay.craigslist.org/sfc/apa/1234567890.html</link>
      <pubDate>Sat, 28 Jun 2025 08:00:00 +0000</pubDate>
      <description><![CDATA[Nice 2br flat in the Mission district.]]></description>
    </item>
    <item>
      <guid>https://sfbay.craigslist.org/sfc/apa/9876543210.html</guid>
      <title>Studio near Caltrain</title>
      <link>https://sfbay.craigslist.org/sfc/apa/9876543210.html</link>
      <pubDate>Sat, 28 Jun 2025 07:00:00 +0000</pubDate>
      <description><![CDATA[Cozy studio.]]></description>
    </item>
  </channel>
</rss>`

describe('fetchCraigslistFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: vi.fn().mockResolvedValue('Forbidden') })
    await expect(fetchCraigslistFeed('https://sfbay.craigslist.org/search/sfc/apa?format=rss')).rejects.toThrow(
      'Craigslist RSS'
    )
  })

  it('parses items from valid RSS', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(SAMPLE_RSS) })
    const items = await fetchCraigslistFeed('https://sfbay.craigslist.org/search/sfc/apa?format=rss')
    expect(items).toHaveLength(2)
    expect(items[0].guid).toBe('https://sfbay.craigslist.org/sfc/apa/1234567890.html')
    expect(items[0].price).toBe(3200)
    expect(items[0].beds).toBe(2)
    expect(items[1].price).toBeNull() // no price in title
    expect(items[1].beds).toBeNull()
  })

  it('sends correct User-Agent header', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(SAMPLE_RSS) })
    await fetchCraigslistFeed('https://sfbay.craigslist.org/search/sfc/apa?format=rss')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('Propinno') }) })
    )
  })
})

describe('upsertCraigslistListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { count: 0, canonicalIds: [] } for empty array', async () => {
    expect(await upsertCraigslistListings([])).toEqual({ count: 0, canonicalIds: [] })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('upserts items correctly', async () => {
    const items = [
      {
        guid: 'https://sfbay.craigslist.org/sfc/apa/1234567890.html',
        title: '$3,200 / 2br - Nice flat in Mission',
        link: 'https://sfbay.craigslist.org/sfc/apa/1234567890.html',
        price: 3200,
        address: 'Nice flat in Mission',
        postedAt: new Date('2025-06-28T08:00:00Z'),
        beds: 2,
        raw: { guid: 'https://sfbay.craigslist.org/sfc/apa/1234567890.html' }
      }
    ]

    const result = await upsertCraigslistListings(items)
    expect(result.count).toBe(1)
    expect(result.canonicalIds).toEqual(['1'])
    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'craigslist',
        sourceId: 'https://sfbay.craigslist.org/sfc/apa/1234567890.html',
        price: 3200,
        beds: 2,
        url: 'https://sfbay.craigslist.org/sfc/apa/1234567890.html'
      })
    )
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1)
  })
})
