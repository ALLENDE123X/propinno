import { inngest } from '../client'
import { sendAdminAlert } from '@/lib/twilio'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

export const failureAlert = inngest.createFunction(
  { id: 'failure-alert', triggers: [{ event: 'inngest/function.failed' }] },
  async ({ event, step }) => {
    await step.run('log-and-alert-failure', async () => {
      const errorMsg = event.data.error.message || 'Unknown error'
      const functionId = event.data.function_id
      const fullError = `Inngest function ${functionId} failed: ${errorMsg}`

      logger.error({ event }, fullError)
      Sentry.captureException(new Error(fullError))

      await sendAdminAlert(`Inngest function failed: ${functionId}. Error: ${errorMsg}`)
    })
  }
)
