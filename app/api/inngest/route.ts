import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import { rentcastPoller } from '@/inngest/functions/rentcastPoller'
import { craigslistPoller } from '@/inngest/functions/craigslistPoller'
import { matchingEngine } from '@/inngest/functions/matchingEngine'
import { twilioSender } from '@/inngest/functions/twilioSender'
import { failureAlert } from '@/inngest/functions/failureAlert'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    rentcastPoller,
    craigslistPoller,
    matchingEngine,
    twilioSender,
    failureAlert,
  ],
})
