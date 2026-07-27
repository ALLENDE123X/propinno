// Shared async run+poll+dataset-fetch helper for every Apify-backed poller
// (all listing sources except rentcastPoller.ts, which calls RentCast's own
// licensed REST API directly, never Apify) - same "one tested home for
// shared logic" pattern as lib/pollerBudget.ts/lib/listingAttributes.ts/
// lib/listingImages.ts.
//
// Why this exists: every poller used to call Apify's *synchronous*
// `run-sync-get-dataset-items` endpoint, which blocks the whole HTTP
// request until the actor run finishes. `/api/inngest`'s route caps at 60s
// (`maxDuration`, see every poller's chunked-upsert comments) - if an actor
// run takes longer, Vercel kills the request with a 504 regardless of
// whether the actor would have eventually succeeded. This happened for
// real in production: craigslist-poller hit it on 2026-07-20, and both
// facebook-poller and apartment-list-poller hit it again on 2026-07-22
// (confirmed via /api/admin/status's recentFailures and the ADMIN_PHONE SMS
// alert log - facebook-poller's listings data went stale as a direct
// result). See the issue this fix was filed under for the full incident.
//
// The fix is Apify's own documented async pattern - start the run (fast,
// returns immediately), poll its status via step.sleep (NOT a blocking
// while-loop - see below), then fetch the dataset once the run succeeds.
// Verified against Apify's real API docs before implementing this (not
// just trusted a summary of them):
//   - POST https://api.apify.com/v2/acts/{actorId}/runs?token={token} -
//     https://docs.apify.com/api/v2/act-runs-post - "Runs an Actor and
//     immediately returns without waiting for the run to finish." Response
//     is `{data: {id, status, defaultDatasetId, ...}}` (the Run object).
//     `/v2/acts/` and `/v2/actors/` are equivalent path aliases for this
//     and every other actor-scoped endpoint below - `/v2/acts/` is used
//     here to match the path segment every poller's existing (now-replaced)
//     `run-sync-get-dataset-items` call already used successfully in
//     production.
//   - GET https://api.apify.com/v2/actor-runs/{runId}?token={token} -
//     https://docs.apify.com/api/v2/actor-run-get - returns the same Run
//     object shape. `data.status` is one of the `ActorJobStatus` enum
//     values: READY, RUNNING, SUCCEEDED, FAILED, TIMING-OUT, TIMED-OUT,
//     ABORTING, ABORTED (confirmed against the docs' own schema, not
//     guessed).
//   - GET https://api.apify.com/v2/actor-runs/{runId}/dataset/items?token={token} -
//     https://docs.apify.com/api/v2/actor-run-dataset-items-get - "a
//     shortcut that resolves the run's defaultDatasetId" and proxies to
//     the Get dataset items endpoint, returning the dataset's items
//     directly as a raw JSON array (identical shape to what
//     run-sync-get-dataset-items used to return) - no separate
//     dataset-ID lookup step needed.
//
// Every network call goes through its own step.run(...) (a durable
// Inngest checkpoint - each one gets its own fresh 60s Vercel invocation,
// same reasoning as the chunked-upsert steps already in every poller), and
// the wait between polls uses step.sleep(...), NOT a blocking `while` loop
// with `await new Promise(r => setTimeout(...))` - the latter would hold
// the Vercel function open for exactly the reason this fix exists to
// eliminate. Same durable-wait convention as
// inngest/functions/twilioSender.ts's quiet-hours step.sleepUntil.
//
// Each poller's fetch<Source>ViaApify(step) becomes a thin wrapper: build
// the actor input (byte-identical to what it sent through the old sync
// endpoint), call runApifyActorAsync(step, actorId, input), return the
// typed items. Per-attempt step names (`check-apify-run-status-${attempt}`)
// follow the same unique-suffix convention as the existing chunked-upsert
// steps (`upsert-listings-chunk-${i}`) - safe here too since each poller
// invocation only ever calls this helper once, so there's no cross-call
// name collision to guard against with a source-specific prefix.
//
// ---------------------------------------------------------------------
// 2026-07-27 (issue #78) - two-phase wait budget + non-retriable failures
// ---------------------------------------------------------------------
// The original budget was a flat 30 polls x 10s (~5 min), justified at the
// time as "a real actor run is usually done well within that". It was, for
// six of the seven actors. It wasn't for apartment-list, and the poller
// paged the admin at 06:30 UTC on 2026-07-27 with "did not finish within
// 30 polls (~5.0min) - last status RUNNING".
//
// The run we gave up on had SUCCEEDED. Apify run 8NAHaL2NsPHaREOCe:
// startedAt 06:30:03.902Z, finishedAt 06:45:26.896Z = 922.99s, exitCode 0,
// "Done! 80 results from 1 items.", $0.185 billed. We paid for it, alerted
// on it, and threw the 80 properties away 10 minutes before they landed.
//
// Sizing the new budget off real run-time history rather than a guess -
// all 11 runs of solidcode~apartmentlist-com-scraper on this account:
//   17.7 20.7 23.6 28.2 28.4 35.0 44.3 57.6 61.5 92.3 | 923.0 seconds
//   min 17.7 / median 35.0 / p90 92.3 / max 923.0, zero non-SUCCEEDED.
// That is a 10x gap between p90 and max with nothing in between: ten
// healthy runs in a tight 17-92s band, one 15-minute stall. The stall is a
// degradation, not extra work - the 923s run returned the same 80 items as
// the fast ones but only 300KB of payload against their 1.58MB (sparser
// photos/units.photos), i.e. it spent 15 minutes retrying, not scraping
// more. Item count is constant across every run, so this is NOT a scope
// problem and lowering MAX_ITEMS_PER_RUN would not have prevented it.
// Across 165 scheduled poller runs (2026-07-23..27) the worst run belonging
// to any *other* actor is 197.0s, so this is apartment-list-specific rather
// than a fleet-wide default being wrong.
//
// So the budget is two-phase rather than simply "a bigger number":
//   - the first FAST_POLL_WINDOW_SECONDS (300s) is byte-identical to the
//     old behaviour - 10s polls - because every one of those 165 healthy
//     runs finishes inside it. Normal-case data latency does not regress.
//   - past that the run is already pathological by definition, so polling
//     at 10s resolution buys nothing; back off to 60s out to a 22-minute
//     ceiling. Fixed 10s polling to 22 minutes would cost ~264 Inngest
//     steps; two-phase costs ~96 for the same ceiling.
// Waiting longer is close to free here: since PR #75 the wait is
// step.sleep, so each poll is its own sub-second Vercel invocation and the
// route's 60s maxDuration is not involved at all. The only cost of a longer
// ceiling is Inngest steps, and the cost of too short a ceiling is a
// paid-for run discarded plus a false-alarm page.
//
// Both function-body throws below are NonRetriableError, and that is
// load-bearing rather than cosmetic. Inngest memoizes step results
// (inngest/types.d.ts: "The ID to use to memoize the result of this step,
// ensuring it is run only once"), and these two errors are thrown in the
// function body, outside any step.run. On an Inngest retry every completed
// step - start-apify-run and all N check-apify-run-status-N - replays from
// state, so the loop re-derives the same stale status and re-throws
// instantly. All four default retries are provably no-ops. Confirmed in
// production: the Apify run list shows no second apartment-list run after
// the 06:30 failure, so the retries never re-started the actor (no
// duplicate billing - but no recovery either). NB this is a real behaviour
// change PR #75 introduced without noticing: before it, the fetch lived
// inside a single step.run, so Inngest's *step-level* retry re-ran the
// whole fetch, and apartment-list-poller is recorded recovering exactly
// that way on 2026-07-22. Errors thrown *inside* the step.run helpers below
// (non-ok HTTP responses) deliberately stay retryable - that is the layer
// where a retry genuinely helps.
//
// Residual risk accepted deliberately: a run that outlives even the
// 22-minute ceiling is still orphaned (it keeps executing on Apify and we
// never read its dataset). Not worth guarding further - the actors are
// billed per result against a MAX_ITEMS_PER_RUN cap, so an orphaned run's
// cost is bounded at that run's normal price no matter how long it lasts,
// and the next scheduled tick re-fetches the same inventory anyway.

import { NonRetriableError } from 'inngest'

export type ApifyRunStatus =
  | 'READY'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMING-OUT'
  | 'TIMED-OUT'
  | 'ABORTING'
  | 'ABORTED'

const TERMINAL_STATUSES: readonly ApifyRunStatus[] = ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']

interface ApifyRun {
  id: string
  status: ApifyRunStatus
  defaultDatasetId?: string
}

interface ApifyRunResponse {
  data: ApifyRun
}

// The minimal shape of Inngest's step tools this helper needs. `run`
// deliberately returns `Promise<unknown>` rather than a generic `Promise<T>`
// - Inngest's real step.run() return type runs the callback's result
// through its own `Jsonify<...>` transform (steps must be JSON-serializable
// to be checkpointed/replayed), which structurally isn't the same generic
// `T` a narrower signature would promise, and fails strict-mode assignment
// otherwise. Every call site below casts the (still just plain-JSON) result
// back to the concrete shape it actually is. Same "just the shape actually
// used" approach the rest of this codebase's lib/ modules take toward
// third-party SDK types.
export interface ApifyStepTools {
  run(id: string, fn: () => Promise<unknown> | unknown): Promise<unknown>
  sleep(id: string, duration: string): Promise<unknown>
}

export interface RunApifyActorAsyncOptions {
  /** Seconds between polls while the run is still inside the fast window. Default 10s. */
  pollIntervalSeconds?: number
  /** How long to keep polling at `pollIntervalSeconds` before backing off. Default 300s - every healthy run of every actor observed in production finishes inside this. */
  fastPollWindowSeconds?: number
  /** Seconds between polls once the run has outlived the fast window and is pathological by definition. Default 60s. */
  slowPollIntervalSeconds?: number
  /** Total wall-clock seconds to wait for a terminal status before failing closed. Default 1320s (22 min) - see this file's header for the run-time history this is sized against. */
  maxWaitSeconds?: number
}

const DEFAULT_POLL_INTERVAL_SECONDS = 10
const DEFAULT_FAST_POLL_WINDOW_SECONDS = 300
const DEFAULT_SLOW_POLL_INTERVAL_SECONDS = 60
const DEFAULT_MAX_WAIT_SECONDS = 1320

async function startApifyRun(actorId: string, input: Record<string, unknown>, token: string): Promise<ApifyRun> {
  const res = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(`Apify start-run for ${actorId} returned ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as ApifyRunResponse
  return body.data
}

async function getApifyRunStatus(runId: string, token: string): Promise<ApifyRun> {
  const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`)
  if (!res.ok) {
    throw new Error(`Apify get-run-status for run ${runId} returned ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as ApifyRunResponse
  return body.data
}

async function getApifyRunDatasetItems<T>(runId: string, token: string): Promise<T[]> {
  const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}`)
  if (!res.ok) {
    throw new Error(`Apify get-dataset-items for run ${runId} returned ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T[]
}

/**
 * Runs an Apify actor via the async run+poll+dataset-fetch pattern instead
 * of the blocking `run-sync-get-dataset-items` endpoint - see this file's
 * header comment for why. Reads APIFY_API_TOKEN itself (same fail-closed
 * check every poller's old fetch<Source>ViaApify() already did) so callers
 * don't need to duplicate it.
 */
export async function runApifyActorAsync<T>(
  step: ApifyStepTools,
  actorId: string,
  input: Record<string, unknown>,
  opts: RunApifyActorAsyncOptions = {}
): Promise<T[]> {
  const apifyToken = process.env.APIFY_API_TOKEN
  if (!apifyToken) {
    throw new Error('APIFY_API_TOKEN is not set')
  }

  const pollIntervalSeconds = opts.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS
  const fastPollWindowSeconds = opts.fastPollWindowSeconds ?? DEFAULT_FAST_POLL_WINDOW_SECONDS
  const slowPollIntervalSeconds = opts.slowPollIntervalSeconds ?? DEFAULT_SLOW_POLL_INTERVAL_SECONDS
  const maxWaitSeconds = opts.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS

  const run = (await step.run('start-apify-run', () => startApifyRun(actorId, input, apifyToken))) as ApifyRun

  let status = run.status
  let attempt = 0
  let waitedSeconds = 0
  while (!TERMINAL_STATUSES.includes(status) && waitedSeconds < maxWaitSeconds) {
    // Two-phase: poll at the fast interval until the run has clearly stopped
    // behaving normally, then back off - see this file's header for the
    // real run-time distribution these two phases are sized against.
    const intervalSeconds =
      waitedSeconds < fastPollWindowSeconds ? pollIntervalSeconds : slowPollIntervalSeconds
    await step.sleep(`wait-for-apify-run-${attempt}`, `${intervalSeconds}s`)
    waitedSeconds += intervalSeconds
    const polled = (await step.run(`check-apify-run-status-${attempt}`, () =>
      getApifyRunStatus(run.id, apifyToken)
    )) as ApifyRun
    status = polled.status
    attempt += 1
  }

  // NonRetriableError, not Error: every completed step above is memoized, so
  // an Inngest retry replays them and re-derives this exact same status
  // instantly. Retrying is a guaranteed no-op - see this file's header.
  if (!TERMINAL_STATUSES.includes(status)) {
    const waitedMinutes = (waitedSeconds / 60).toFixed(1)
    throw new NonRetriableError(
      `Apify run ${run.id} for ${actorId} did not finish within ${attempt} polls (~${waitedMinutes}min) - last status ${status}. The run may still be executing on Apify; the next scheduled tick will re-fetch this source.`
    )
  }

  if (status !== 'SUCCEEDED') {
    throw new NonRetriableError(
      `Apify run ${run.id} for ${actorId} finished with status ${status}, not SUCCEEDED`
    )
  }

  return (await step.run('fetch-apify-dataset', () => getApifyRunDatasetItems<T>(run.id, apifyToken))) as T[]
}
