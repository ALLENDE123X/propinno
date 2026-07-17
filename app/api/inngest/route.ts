import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import { rentcastPoller } from '@/inngest/functions/rentcastPoller'
import { craigslistPoller } from '@/inngest/functions/craigslistPoller'
import { facebookPoller } from '@/inngest/functions/facebookPoller'
import { spareroomPoller } from '@/inngest/functions/spareroomPoller'
import { realtorPoller } from '@/inngest/functions/realtorPoller'
import { apartmentsPoller } from '@/inngest/functions/apartmentsPoller'
import { apartmentListPoller } from '@/inngest/functions/apartmentListPoller'
import { zumperPoller } from '@/inngest/functions/zumperPoller'
import { matchingEngine } from '@/inngest/functions/matchingEngine'
import { twilioSender } from '@/inngest/functions/twilioSender'
import { failureAlert } from '@/inngest/functions/failureAlert'

// Bumped from the framework default (10s on Hobby) to the Hobby-plan max.
// The new Apify-based craigslistPoller step can legitimately take longer
// than 10s to complete (a live test run took ~16s for 5 items; 80-item
// production runs will take longer), so the default would risk clipping
// it mid-run and turning a working call into a spurious timeout failure.
export const maxDuration = 60

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    rentcastPoller,
    craigslistPoller,
    facebookPoller,
    spareroomPoller,
    realtorPoller,
    apartmentsPoller,
    apartmentListPoller,
    zumperPoller,
    matchingEngine,
    twilioSender,
    failureAlert,
  ],
})
