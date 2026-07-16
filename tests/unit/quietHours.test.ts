import { describe, it, expect } from 'vitest'
import { isWithinQuietHours, nextQuietHoursEnd, startOfLocalDay } from '@/lib/quietHours'

// All instants below are expressed in UTC and converted mentally against
// America/Los_Angeles offsets: PDT (UTC-7) roughly mid-March to early-Nov,
// PST (UTC-8) otherwise. 2026 DST transitions: spring-forward March 8
// 2026 02:00->03:00, fall-back November 1 2026 02:00->01:00.

describe('isWithinQuietHours', () => {
  it('is false outside an overnight window (21:00-08:00 PDT)', () => {
    // 2026-07-16T20:00:00Z = 13:00 PDT (1pm) - well outside quiet hours.
    const now = new Date('2026-07-16T20:00:00Z')
    expect(isWithinQuietHours(now, '21:00:00', '08:00:00')).toBe(false)
  })

  it('is true right at the start boundary of an overnight window', () => {
    // 2026-07-17T04:00:00Z = 21:00 PDT exactly.
    const now = new Date('2026-07-17T04:00:00Z')
    expect(isWithinQuietHours(now, '21:00:00', '08:00:00')).toBe(true)
  })

  it('is true after midnight, still inside an overnight window', () => {
    // 2026-07-17T09:00:00Z = 02:00 PDT - after midnight, before quiet_end.
    const now = new Date('2026-07-17T09:00:00Z')
    expect(isWithinQuietHours(now, '21:00:00', '08:00:00')).toBe(true)
  })

  it('is false right at the end boundary (end is exclusive)', () => {
    // 2026-07-17T15:00:00Z = 08:00 PDT exactly.
    const now = new Date('2026-07-17T15:00:00Z')
    expect(isWithinQuietHours(now, '21:00:00', '08:00:00')).toBe(false)
  })

  it('handles a same-day (non-wrapping) window', () => {
    // 09:00-17:00 PDT quiet window. 2026-07-16T18:00:00Z = 11:00 PDT.
    const inside = new Date('2026-07-16T18:00:00Z')
    // 2026-07-16T14:00:00Z = 07:00 PDT.
    const outside = new Date('2026-07-16T14:00:00Z')
    expect(isWithinQuietHours(inside, '09:00:00', '17:00:00')).toBe(true)
    expect(isWithinQuietHours(outside, '09:00:00', '17:00:00')).toBe(false)
  })

  it('treats equal start and end as always-open, not always-quiet', () => {
    const now = new Date('2026-07-17T04:00:00Z')
    expect(isWithinQuietHours(now, '21:00:00', '21:00:00')).toBe(false)
  })

  it('accepts Postgres-style time strings with fractional seconds', () => {
    const now = new Date('2026-07-17T04:00:00Z')
    expect(isWithinQuietHours(now, '21:00:00.000000', '08:00:00.000000')).toBe(true)
  })
})

describe('nextQuietHoursEnd', () => {
  it('returns todays quiet_end when it is still ahead of now', () => {
    // 2026-07-17T09:00:00Z = 02:00 PDT, quiet_end 08:00 PDT is later today.
    const now = new Date('2026-07-17T09:00:00Z')
    const end = nextQuietHoursEnd(now, '08:00:00')
    // 08:00 PDT = 15:00Z
    expect(end.toISOString()).toBe('2026-07-17T15:00:00.000Z')
  })

  it('rolls to tomorrow (local date) when quiet_end already passed today', () => {
    // 2026-07-17T04:00:00Z = 2026-07-16 21:00 PDT (just entered quiet hours
    // for the evening of July 16, local date is still the 16th). quiet_end
    // 08:00 already passed earlier that same local day, so the next
    // occurrence is the morning of the 17th.
    const now = new Date('2026-07-17T04:00:00Z')
    const end = nextQuietHoursEnd(now, '08:00:00')
    expect(end.toISOString()).toBe('2026-07-17T15:00:00.000Z')
  })

  it('is correct across the spring-forward DST transition (2026-03-08)', () => {
    // 2026-03-08 01:00 PST (still standard time, before the 2am jump).
    // PST = UTC-8, so 01:00 PST = 09:00Z.
    const now = new Date('2026-03-08T09:00:00Z')
    const end = nextQuietHoursEnd(now, '08:00:00')
    // By the time 08:00 local arrives that morning, clocks have sprung
    // forward to PDT (UTC-7): 08:00 PDT = 15:00Z (not 16:00Z, which is what
    // a fixed -8h offset would incorrectly compute).
    expect(end.toISOString()).toBe('2026-03-08T15:00:00.000Z')
  })

  it('is correct across the fall-back DST transition (2026-11-01)', () => {
    // 2026-11-01 01:00 PDT (still daylight time, before the 2am fall-back).
    // PDT = UTC-7, so 01:00 PDT = 08:00Z.
    const now = new Date('2026-11-01T08:00:00Z')
    const end = nextQuietHoursEnd(now, '08:00:00')
    // By 08:00 local that morning, clocks have fallen back to PST (UTC-8):
    // 08:00 PST = 16:00Z (not 15:00Z, which is what a fixed -7h offset
    // would incorrectly compute).
    expect(end.toISOString()).toBe('2026-11-01T16:00:00.000Z')
  })
})

describe('startOfLocalDay', () => {
  it('returns midnight America/Los_Angeles as a UTC instant (PDT)', () => {
    // 2026-07-16T20:00:00Z = 13:00 PDT on July 16.
    const now = new Date('2026-07-16T20:00:00Z')
    // Midnight PDT on July 16 = 07:00Z on July 16.
    expect(startOfLocalDay(now).toISOString()).toBe('2026-07-16T07:00:00.000Z')
  })

  it('returns midnight America/Los_Angeles as a UTC instant (PST)', () => {
    // 2026-01-16T20:00:00Z = 12:00 PST on Jan 16.
    const now = new Date('2026-01-16T20:00:00Z')
    // Midnight PST on Jan 16 = 08:00Z on Jan 16.
    expect(startOfLocalDay(now).toISOString()).toBe('2026-01-16T08:00:00.000Z')
  })

  it('rolls back to the previous UTC calendar day when local time is before midnight UTC-wise', () => {
    // 2026-07-16T05:00:00Z = 2026-07-15 22:00 PDT (still July 15 locally).
    const now = new Date('2026-07-16T05:00:00Z')
    expect(startOfLocalDay(now).toISOString()).toBe('2026-07-15T07:00:00.000Z')
  })
})
