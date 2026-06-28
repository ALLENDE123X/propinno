import { inngest } from '../client'
import { sendAdminAlert } from '@/lib/twilio'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { Redis } from '@upstash/redis'

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null

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

      await sendAdminAlert(`Inngest function failed: ${functionId}. Error: ${errorMsg}`)
    })
  }
)
