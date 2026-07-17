import { describe, it, expect } from 'vitest'
import {
  parseImagesFromRentcast,
  parseImagesFromCraigslist,
  parseImagesFromFacebook,
  parseImagesFromSpareRoom,
  parseImagesFromRealtor,
  parseImagesFromApartments,
  parseImagesFromApartmentList,
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

describe('parseImagesFromSpareRoom', () => {
  it('extracts large_url from each photo object (real Apify shape, confirmed 2026-07-17)', () => {
    const item = {
      photos: [
        { large_url: 'https://photos.spareroom.com/images/flatshare/listings/large/21/10/211079791.jpg', thumb_url: 'https://photos.spareroom.com/images/flatshare/listings/thumbs/21/10/211079791.jpg' },
        { large_url: 'https://photos.spareroom.com/images/flatshare/listings/large/21/10/211079801.jpg', thumb_url: 'https://photos.spareroom.com/images/flatshare/listings/thumbs/21/10/211079801.jpg' }
      ]
    }
    expect(parseImagesFromSpareRoom(item)).toEqual([
      'https://photos.spareroom.com/images/flatshare/listings/large/21/10/211079791.jpg',
      'https://photos.spareroom.com/images/flatshare/listings/large/21/10/211079801.jpg'
    ])
  })

  it('returns [] (not a guess) when photos is absent', () => {
    expect(parseImagesFromSpareRoom({})).toEqual([])
  })

  it('returns [] when photos is not an array (malformed real-world payload)', () => {
    expect(parseImagesFromSpareRoom({ photos: 'not-an-array' })).toEqual([])
  })

  it('drops photo objects missing a usable large_url and de-dupes', () => {
    const item = {
      photos: [
        { large_url: 'https://photos.spareroom.com/a.jpg' },
        { large_url: null },
        {},
        { large_url: 'https://photos.spareroom.com/a.jpg' }
      ]
    }
    expect(parseImagesFromSpareRoom(item)).toEqual(['https://photos.spareroom.com/a.jpg'])
  })
})

describe('parseImagesFromRealtor', () => {
  it('prefers the photo_urls gallery when present (real kawsar/realtor-Search shape, confirmed 2026-07-17)', () => {
    const item = {
      primary_photo_url: 'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m1926513261s.jpg',
      photo_urls: [
        'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m1926513261s.jpg',
        'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m2824488148s.jpg'
      ]
    }
    expect(parseImagesFromRealtor(item)).toEqual([
      'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m1926513261s.jpg',
      'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m2824488148s.jpg'
    ])
  })

  it('falls back to primary_photo_url when photo_urls is absent', () => {
    const item = { primary_photo_url: 'https://ap.rdcpix.com/primary.jpg' }
    expect(parseImagesFromRealtor(item)).toEqual(['https://ap.rdcpix.com/primary.jpg'])
  })

  it('falls back to primary_photo_url when photo_urls is an empty array', () => {
    const item = { primary_photo_url: 'https://ap.rdcpix.com/primary.jpg', photo_urls: [] }
    expect(parseImagesFromRealtor(item)).toEqual(['https://ap.rdcpix.com/primary.jpg'])
  })

  it('returns [] (not a guess) when neither field is present', () => {
    expect(parseImagesFromRealtor({})).toEqual([])
  })

  it('filters out non-string entries and de-dupes in the gallery', () => {
    const item = { photo_urls: ['https://ap.rdcpix.com/a.jpg', null, 42, 'https://ap.rdcpix.com/a.jpg', ''] }
    expect(parseImagesFromRealtor(item)).toEqual(['https://ap.rdcpix.com/a.jpg'])
  })
})

describe('parseImagesFromApartments', () => {
  it('returns the per-unit floor-plan photo as a single-element array (real Apify shape, confirmed 2026-07-17)', () => {
    const rental = { image: 'https://images1.apartments.com/i2/V-VbAsRDOYIofVoqaxWdzmPNpOpV6DxcHBRYZMO3aqk/105/image.jpg' }
    expect(parseImagesFromApartments(rental)).toEqual([
      'https://images1.apartments.com/i2/V-VbAsRDOYIofVoqaxWdzmPNpOpV6DxcHBRYZMO3aqk/105/image.jpg'
    ])
  })

  it('returns [] (not a guess) when image is absent - confirmed real on some live units', () => {
    expect(parseImagesFromApartments({})).toEqual([])
  })

  it('returns [] when image is null', () => {
    expect(parseImagesFromApartments({ image: null })).toEqual([])
  })

  it('does not crash when image is not a string (malformed real-world payload)', () => {
    expect(parseImagesFromApartments({ image: 42 })).toEqual([])
  })
})

describe('parseImagesFromApartmentList', () => {
  it('orders the specific unit photo first, followed by the property gallery (real Apify shape, confirmed 2026-07-17)', () => {
    const listing = {
      unitPhotos: ['https://cdn.apartmentlist.com/image/upload/unit-1.jpg'],
      propertyPhotos: [
        'https://cdn.apartmentlist.com/image/upload/gallery-1.jpg',
        'https://cdn.apartmentlist.com/image/upload/gallery-2.jpg'
      ]
    }
    expect(parseImagesFromApartmentList(listing)).toEqual([
      'https://cdn.apartmentlist.com/image/upload/unit-1.jpg',
      'https://cdn.apartmentlist.com/image/upload/gallery-1.jpg',
      'https://cdn.apartmentlist.com/image/upload/gallery-2.jpg'
    ])
  })

  it('falls back to the property gallery when the unit has no photo of its own', () => {
    const listing = {
      unitPhotos: undefined,
      propertyPhotos: ['https://cdn.apartmentlist.com/image/upload/gallery-1.jpg']
    }
    expect(parseImagesFromApartmentList(listing)).toEqual([
      'https://cdn.apartmentlist.com/image/upload/gallery-1.jpg'
    ])
  })

  it('de-dupes when the unit photo also appears in the property gallery', () => {
    const listing = {
      unitPhotos: ['https://cdn.apartmentlist.com/image/upload/shared.jpg'],
      propertyPhotos: ['https://cdn.apartmentlist.com/image/upload/shared.jpg']
    }
    expect(parseImagesFromApartmentList(listing)).toEqual([
      'https://cdn.apartmentlist.com/image/upload/shared.jpg'
    ])
  })

  it('returns [] (not a guess) when neither field is present', () => {
    expect(parseImagesFromApartmentList({})).toEqual([])
  })

  it('does not crash when photo fields are malformed', () => {
    expect(
      parseImagesFromApartmentList({ unitPhotos: 'not-an-array', propertyPhotos: null })
    ).toEqual([])
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
