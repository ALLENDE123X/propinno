/**
 * AH-019 notification-scheduling helpers: quiet hours + the "today" boundary
 * used for the daily SMS cap.
 *
 * Propinno has no stored per-user timezone (it's an SF-only product), so
 * every function here hardcodes America/Los_Angeles rather than UTC - UTC
 * would make "9pm-8am quiet hours" mean something different from what an SF
 * user typed in, and would drift by an extra hour for half the year (PDT vs
 * PST) if hardcoded as a fixed offset instead of a real IANA zone. All
 * functions take `now` as an explicit parameter (never call `Date.now()`
 * internally) so callers can test them with fixed instants instead of
 * mocking global time.
 */

export const DEFAULT_TIME_ZONE = 'America/Los_Angeles'

/** Truncates a Postgres `time` value ("HH:MM:SS" or "HH:MM:SS.ffffff") to "HH:MM:SS". */
function normalizeTime(value: string): string {
  return value.slice(0, 8)
}

/** "HH:MM:SS" wall-clock time of `date` in `timeZone`. */
function localTimeOfDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('hour')}:${get('minute')}:${get('second')}`
}

/** Local calendar date (year/month/day) of `date` in `timeZone`. */
function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day') }
}

/**
 * The signed offset (ms) such that `localWallClockMs = utcInstantMs + offset`
 * for the given instant, in the given IANA time zone (negative west of UTC,
 * e.g. -7h/-8h for America/Los_Angeles depending on DST). Evaluated at the
 * specific instant passed in, so it's correct across DST transitions.
 */
function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asLocalUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asLocalUtc - date.getTime()
}

/**
 * Converts local wall-clock components (year/month/day + "HH:MM:SS") in
 * `timeZone` to the actual UTC instant they represent. Corrects once for DST
 * since the offset at the naive guess can differ from the offset at the
 * resolved instant on the two transition days per year.
 */
function zonedTimeToUtc(year: number, month: number, day: number, time: string, timeZone: string): Date {
  const [h, m, s] = normalizeTime(time).split(':').map(Number)
  const naiveUtcMs = Date.UTC(year, month - 1, day, h, m, s)
  const firstPassOffset = getTimeZoneOffsetMs(new Date(naiveUtcMs), timeZone)
  const firstPassUtcMs = naiveUtcMs - firstPassOffset
  const secondPassOffset = getTimeZoneOffsetMs(new Date(firstPassUtcMs), timeZone)
  return new Date(naiveUtcMs - secondPassOffset)
}

/**
 * True if `now` falls within [quietStart, quietEnd) local wall-clock time in
 * `timeZone`. Handles the overnight case (quietStart > quietEnd, e.g.
 * "21:00:00" -> "08:00:00") by wrapping past midnight. Equal start/end is
 * treated as "no quiet window" (always send) rather than "quiet all day" -
 * a user who sets both fields to the same value almost certainly means
 * "off", and silently blocking 100% of texts for such a user would be a
 * much worse failure mode than the reverse.
 */
export function isWithinQuietHours(
  now: Date,
  quietStart: string,
  quietEnd: string,
  timeZone: string = DEFAULT_TIME_ZONE
): boolean {
  const start = normalizeTime(quietStart)
  const end = normalizeTime(quietEnd)
  if (start === end) return false

  const current = localTimeOfDay(now, timeZone)
  if (start < end) {
    return current >= start && current < end
  }
  return current >= start || current < end
}

/**
 * The next UTC instant at which local wall-clock time in `timeZone` equals
 * `quietEnd`. Meant to be called only when `now` is already known to be
 * within the quiet window (see `isWithinQuietHours`): picks today's
 * occurrence if it's still ahead of `now`, otherwise tomorrow's - covers the
 * overnight-wrap case where quietEnd's clock time is numerically earlier
 * than quietStart's but calendar-wise still in the future.
 */
export function nextQuietHoursEnd(now: Date, quietEnd: string, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const { year, month, day } = localDateParts(now, timeZone)
  const todayCandidate = zonedTimeToUtc(year, month, day, quietEnd, timeZone)
  if (todayCandidate > now) return todayCandidate
  // Date.UTC normalizes day overflow (e.g. day 32 in July -> Aug 1), so this
  // is safe without manually rolling the calendar forward first.
  return zonedTimeToUtc(year, month, day + 1, quietEnd, timeZone)
}

/** UTC instant of local midnight (start of "today" in `timeZone`) for `now`. */
export function startOfLocalDay(now: Date, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const { year, month, day } = localDateParts(now, timeZone)
  return zonedTimeToUtc(year, month, day, '00:00:00', timeZone)
}
