import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import { rentcastPoller } from '@/inngest/functions/rentcastPoller'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    rentcastPoller,
  ],
})
