import { describe, it, expect } from 'vitest'
import {
  parseImagesFromRentcast,
  parseImagesFromCraigslist,
  parseImagesFromFacebook,
  parseImagesFromZumper
} from '@/lib/listingImages'

describe('parseImagesFromRentcast', () => {
  it('returns [] (not a guess) for a real RentCast shape - confirmed 2026-07-17 against 895 live rows and a fresh live API call with zero image data anywhere', () => {
    const raw = {
      id: '264-Guerrero-St,-San-Francisco,-CA-94103',
      formattedAddress: '264 Guerrero St, San Francisco, CA 94103',
      city: 'San Francisco',
      price: 7400,
      bedrooms: 2,
      bathrooms: 1,
      propertyType: 'Condo',
      squareFootage: 1464
    }
    expect(parseImagesFromRentcast(raw)).toEqual([])
  })

  it('returns [] for an empty object', () => {
    expect(parseImagesFromRentcast({})).toEqual([])
  })
})

describe('parseImagesFromCraigslist', () => {
  it('returns the pics array as-is (real Apify shape - direct URL strings, confirmed 2026-07-17)', () => {
    const item = {
      pics: [
        'https://images.craigslist.org/00O0O_7jErhjDdqjs_0sX0CI_600x450.jpg',
        'https://images.craigslist.org/00i0i_86uqQ11WUAd_0t20CI_600x450.jpg'
      ]
    }
    expect(parseImagesFromCraigslist(item)).toEqual([
      'https://images.craigslist.org/00O0O_7jErhjDdqjs_0sX0CI_600x450.jpg',
      'https://images.craigslist.org/00i0i_86uqQ11WUAd_0t20CI_600x450.jpg'
    ])
  })

  it('returns [] (not a guess) when pics is absent', () => {
    expect(parseImagesFromCraigslist({})).toEqual([])
  })

  it('returns [] when pics is null', () => {
    expect(parseImagesFromCraigslist({ pics: null })).toEqual([])
  })

  it('does not crash when pics is not an array (malformed real-world payload)', () => {
    expect(parseImagesFromCraigslist({ pics: 'not-an-array' })).toEqual([])
  })

  it('filters out non-string entries and de-dupes', () => {
    const item = { pics: ['https://images.craigslist.org/a.jpg', null, 42, 'https://images.craigslist.org/a.jpg', ''] }
    expect(parseImagesFromCraigslist(item)).toEqual(['https://images.craigslist.org/a.jpg'])
  })
})

describe('parseImagesFromFacebook', () => {
  it('prefers the full gallery from moreDetails.listing_photos when present (real Apify shape, confirmed 2026-07-17)', () => {
    const item = {
      primary_listing_photo: {
        photo_image_url: 'https://scontent.fhex1-1.fna.fbcdn.net/primary.jpg'
      },
      moreDetails: {
        listing_photos: [
          { image: { uri: 'https://scontent-bos5-1.xx.fbcdn.net/gallery-1.jpg' } },
          { image: { uri: 'https://scontent-bos5-1.xx.fbcdn.net/gallery-2.jpg' } }
        ]
      }
    }
    expect(parseImagesFromFacebook(item)).toEqual([
      'https://scontent-bos5-1.xx.fbcdn.net/gallery-1.jpg',
      'https://scontent-bos5-1.xx.fbcdn.net/gallery-2.jpg'
    ])
  })

  it('falls back to primary_listing_photo when moreDetails.listing_photos is absent', () => {
    const item = {
      primary_listing_photo: {
        photo_image_url: 'https://scontent.fhex1-1.fna.fbcdn.net/primary.jpg'
      }
    }
    expect(parseImagesFromFacebook(item)).toEqual(['https://scontent.fhex1-1.fna.fbcdn.net/primary.jpg'])
  })

  it('falls back to primary_listing_photo when the gallery array is empty', () => {
    const item = {
      primary_listing_photo: { photo_image_url: 'https://scontent.fhex1-1.fna.fbcdn.net/primary.jpg' },
      moreDetails: { listing_photos: [] }
    }
    expect(parseImagesFromFacebook(item)).toEqual(['https://scontent.fhex1-1.fna.fbcdn.net/primary.jpg'])
  })

  it('returns [] (not a guess) when neither field is present', () => {
    expect(parseImagesFromFacebook({})).toEqual([])
  })

  it('does not crash on malformed gallery entries', () => {
    const item = {
      moreDetails: { listing_photos: [{ image: {} }, null, { image: { uri: 42 } }] as unknown[] }
    }
    expect(parseImagesFromFacebook(item as Parameters<typeof parseImagesFromFacebook>[0])).toEqual([])
  })
})

describe('parseImagesFromZumper', () => {
  it('returns [] (not a guess) for a real Zumper shape - confirmed 2026-07-17 against two live benthepythondev/zumper-rental-scraper calls where image_ids are opaque numeric IDs with no resolvable URL anywhere in the actor output', () => {
    const item = { image_ids: [238066372, 901314944, 895186948] }
    expect(parseImagesFromZumper(item)).toEqual([])
  })

  it('returns [] for an empty object', () => {
    expect(parseImagesFromZumper({})).toEqual([])
  })
})
