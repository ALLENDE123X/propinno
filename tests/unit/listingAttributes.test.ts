import { describe, it, expect } from 'vitest'
import {
  parsePetsFromRentcast,
  parseLaundryFromRentcast,
  parsePetsFromCraigslist,
  parseLaundryFromCraigslist
} from '@/lib/listingAttributes'

describe('parsePetsFromRentcast', () => {
  it('returns null when no pet-related field is present (real RentCast shape, confirmed 2026-07-16 against 801 live rows)', () => {
    const raw = {
      id: '3427-Divisadero-St',
      city: 'San Francisco',
      price: 9995,
      bedrooms: 2,
      bathrooms: 1,
      propertyType: 'Apartment',
      squareFootage: 1800,
      formattedAddress: '3427 Divisadero St, San Francisco, CA 94123'
    }
    expect(parsePetsFromRentcast(raw)).toBeNull()
  })

  it('returns null for an empty object', () => {
    expect(parsePetsFromRentcast({})).toBeNull()
  })

  it('parses a plausible future petsAllowed text field if RentCast ever adds one', () => {
    expect(parsePetsFromRentcast({ petsAllowed: 'No pets' })).toBe('no')
    expect(parsePetsFromRentcast({ petPolicy: 'Pets allowed' })).toBe('yes')
  })

  it('does not guess from an unrecognized field shape', () => {
    expect(parsePetsFromRentcast({ petsAllowed: true })).toBeNull()
    expect(parsePetsFromRentcast({ amenities: ['dogs are OK'] })).toBeNull()
  })
})

describe('parseLaundryFromRentcast', () => {
  it('returns null when no laundry-related field is present (real RentCast shape)', () => {
    const raw = {
      id: '270-Turk-St',
      city: 'San Francisco',
      price: 2092,
      bedrooms: 0,
      bathrooms: 1,
      propertyType: 'Apartment'
    }
    expect(parseLaundryFromRentcast(raw)).toBeNull()
  })

  it('parses a plausible future laundryType text field if RentCast ever adds one', () => {
    expect(parseLaundryFromRentcast({ laundryType: 'W/D in unit' })).toBe('in_unit')
    expect(parseLaundryFromRentcast({ laundry: 'Laundry room on site' })).toBe('on_site')
  })
})

describe('parsePetsFromCraigslist', () => {
  it('reads cats-only from the structured amenities array (real Apify shape)', () => {
    const item = {
      amenities: ['25 per adult', 'monthly', 'cats are OK - purrr', 'apartment', 'laundry in bldg', 'carport'],
      title: 'Nice flat',
      post: ''
    }
    expect(parsePetsFromCraigslist(item)).toBe('cats')
  })

  it('reads dogs-only from the structured amenities array', () => {
    const item = { amenities: ['dogs are OK - wooof', 'apartment'], title: '', post: '' }
    expect(parsePetsFromCraigslist(item)).toBe('dogs')
  })

  it('reads cats_and_dogs when both tags are present (real Apify shape)', () => {
    const item = {
      amenities: ['monthly', 'cats are OK - purrr', 'apartment', 'dogs are OK - wooof', 'w/d in unit', 'no smoking'],
      title: 'Dishwasher, Community Workspaces',
      post: ''
    }
    expect(parsePetsFromCraigslist(item)).toBe('cats_and_dogs')
  })

  it('falls back to "no pets" free text when amenities has no pet tag', () => {
    const item = { amenities: ['apartment', 'w/d in unit'], title: 'Cozy studio', post: 'Clean unit, no pets please.' }
    expect(parsePetsFromCraigslist(item)).toBe('no')
  })

  it('falls back to generic "pets ok" free text when amenities has no pet tag', () => {
    const item = { amenities: ['apartment'], title: 'Cozy studio', post: 'Great location, pets ok with deposit.' }
    expect(parsePetsFromCraigslist(item)).toBe('yes')
  })

  it('returns null (not a guess) when neither amenities nor text mention pets at all', () => {
    const item = { amenities: ['apartment', 'w/d in unit'], title: 'Cozy studio near BART', post: 'Freshly painted, great light.' }
    expect(parsePetsFromCraigslist(item)).toBeNull()
  })

  it('returns null when amenities/title/post are all missing', () => {
    expect(parsePetsFromCraigslist({})).toBeNull()
  })

  it('does not crash when amenities is not an array (malformed real-world payload)', () => {
    expect(parsePetsFromCraigslist({ amenities: 'not-an-array', title: '', post: '' })).toBeNull()
  })
})

describe('parseLaundryFromCraigslist', () => {
  it('reads in_unit from the structured amenities array (real Apify shape)', () => {
    const item = { amenities: ['cats are OK - purrr', 'w/d in unit', 'detached garage'], title: '', post: '' }
    expect(parseLaundryFromCraigslist(item)).toBe('in_unit')
  })

  it('reads hookups from the structured amenities array', () => {
    const item = { amenities: ['dogs are OK - wooof', 'w/d hookups', 'detached garage'], title: '', post: '' }
    expect(parseLaundryFromCraigslist(item)).toBe('hookups')
  })

  it('reads on_site ("laundry in bldg") from the structured amenities array (real Apify shape)', () => {
    const item = { amenities: ['25 per adult', 'monthly', 'cats are OK - purrr', 'laundry in bldg', 'carport'], title: '', post: '' }
    expect(parseLaundryFromCraigslist(item)).toBe('on_site')
  })

  it('prefers in_unit over a weaker signal when multiple amenities tags are present', () => {
    const item = { amenities: ['w/d hookups', 'w/d in unit'], title: '', post: '' }
    expect(parseLaundryFromCraigslist(item)).toBe('in_unit')
  })

  it('falls back to free text when amenities has no laundry tag', () => {
    const item = { amenities: ['cats are OK - purrr'], title: '', post: 'Unit features in-unit W/D and dishwasher.' }
    expect(parseLaundryFromCraigslist(item)).toBe('in_unit')
  })

  it('falls back to free text for on-site laundry room mentions', () => {
    const item = { amenities: [], title: '', post: 'Shared laundry room on site, coin operated.' }
    expect(parseLaundryFromCraigslist(item)).toBe('on_site')
  })

  it('returns null (not a guess) when laundry is never mentioned', () => {
    const item = { amenities: ['cats are OK - purrr', 'no smoking'], title: 'Sunny 1BR', post: 'Hardwood floors, great views.' }
    expect(parseLaundryFromCraigslist(item)).toBeNull()
  })
})
