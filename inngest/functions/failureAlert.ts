import { inngest } from '../client'
import { sendAdminAlert } from '@/lib/twilio'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { Redis } from '@upstash/redis'

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null

// A function wedged failing on every cron tick (e.g. every 15 min) should
// not text the admin phone dozens of times a day for the same root cause.
// Only the first failure per function within this window sends an SMS;
// every failure is still logged to Sentry/Redis regardless.
const ALERT_COOLDOWN_SECONDS = 60 * 60 // 1 hour

export const failureAlert = inngest.createFunction(
  { id: 'failure-alert', triggers: [{ event: 'inngest/function.failed' }] },
  async ({ event, step }) => {
    await step.run('log-and-alert-failure', async () => {
      const errorMsg = event.data.error.message || 'Unknown error'
      const functionId = event.data.function_id
      const fullError = `Inngest function ${functionId} failed: ${errorMsg}`

      logger.error({ event }, fullError)
      Sentry.captureException(new Error(fullError))

      if (redis) {
        try {
          await redis.lpush('recent_failures', { functionId, errorMsg, time: Date.now() })
          await redis.ltrim('recent_failures', 0, 9)
        } catch (e) {
          logger.error({ error: e }, 'Failed to record failure in Redis')
        }
      }

      if (!redis) {
        // No Redis configured - fall back to original unthrottled behavior
        // rather than silently dropping alerts.
        await sendAdminAlert(`Inngest function failed: ${functionId}. Error: ${errorMsg}`)
        return
      }

      try {
        const cooldownKey = `alert-cooldown:${functionId}`
        const isFirstInWindow = await redis.set(cooldownKey, '1', {
          nx: true,
          ex: ALERT_COOLDOWN_SECONDS,
        })
        if (isFirstInWindow) {
          await sendAdminAlert(`Inngest function failed: ${functionId}. Error: ${errorMsg}`)
        } else {
          logger.warn({ functionId }, 'Suppressing repeat failure alert (still within cooldown)')
        }
      } catch (e) {
        logger.error({ error: e }, 'Failed to check alert cooldown, sending alert anyway')
        await sendAdminAlert(`Inngest function failed: ${functionId}. Error: ${errorMsg}`)
      }
    })
  }
)
