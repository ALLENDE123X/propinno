import { Redis } from '@upstash/redis'

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null

/**
 * Atomically claims one "slot" against a daily budget for a named poller.
 * Returns true if the caller is within budget and should proceed, false if
 * today's budget is already used up. Fails OPEN (returns true) if Redis
 * isn't configured or errors - this is a safety net on top of normal
 * operation, not a dependency normal operation should break on.
 *
 * This exists because of a real incident: an unbounded RentCast cron
 * (*/15 * * * *, no cap) burned $100 in 6 days with zero paying
 * subscribers. A hard per-day request ceiling, independent of and in
 * addition to whatever the cron schedule says, means a misconfigured cron
 * or an Inngest retry storm can never repeat that - worst case is one
 * bad day capped at maxPerDay requests, not an unbounded bleed until
 * someone happens to notice the bill.
 */
export async function claimDailyBudget(pollerName: string, maxPerDay: number): Promise<boolean> {
  if (!redis) return true

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  const key = `poller-budget:${pollerName}:${today}`

  try {
    const count = await redis.incr(key)
    if (count === 1) {
      // First claim of the day for this poller - expire in 2 days so the
      // key self-cleans without needing a separate cleanup job.
      await redis.expire(key, 60 * 60 * 48)
    }
    return count <= maxPerDay
  } catch {
    return true
  }
}
