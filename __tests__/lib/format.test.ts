import { describe, it, expect } from 'vitest'
import { formatPrice, timeAgo } from '@/lib/format'

describe('formatPrice', () => {
  it('returns N/A for null/zero', () => {
    expect(formatPrice(null)).toBe('N/A')
    expect(formatPrice(0)).toBe('N/A')
  })

  it('formats sub-1000 prices as-is', () => {
    expect(formatPrice(850)).toBe('$850')
  })

  it('formats 1000+ prices in k-notation', () => {
    expect(formatPrice(2800)).toBe('$2.8k')
    expect(formatPrice(1000)).toBe('$1.0k')
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-07-16T12:00:00Z').getTime()

  it('returns unknown for null', () => {
    expect(timeAgo(null, now)).toBe('unknown')
  })

  it('returns "just now" for under an hour', () => {
    const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString()
    expect(timeAgo(thirtyMinAgo, now)).toBe('just now')
  })

  it('returns hours for under a day', () => {
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000).toISOString()
    expect(timeAgo(fiveHoursAgo, now)).toBe('5h')
  })

  it('returns days for a day or more', () => {
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(timeAgo(threeDaysAgo, now)).toBe('3d')
  })
})
