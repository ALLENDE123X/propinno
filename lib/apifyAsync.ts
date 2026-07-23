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
  /** Seconds to wait between poll attempts. Default 10s. */
  pollIntervalSeconds?: number
  /** Max poll attempts before failing closed. Default 30 (~5 minutes at the default 10s interval) - a real actor run is usually done well within that, see each poller's own live-tested run-time notes. */
  maxPolls?: number
}

const DEFAULT_POLL_INTERVAL_SECONDS = 10
const DEFAULT_MAX_POLLS = 30

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
  const maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS

  const run = (await step.run('start-apify-run', () => startApifyRun(actorId, input, apifyToken))) as ApifyRun

  let status = run.status
  let attempt = 0
  while (!TERMINAL_STATUSES.includes(status) && attempt < maxPolls) {
    await step.sleep(`wait-for-apify-run-${attempt}`, `${pollIntervalSeconds}s`)
    const polled = (await step.run(`check-apify-run-status-${attempt}`, () =>
      getApifyRunStatus(run.id, apifyToken)
    )) as ApifyRun
    status = polled.status
    attempt += 1
  }

  if (!TERMINAL_STATUSES.includes(status)) {
    const waitedMinutes = ((maxPolls * pollIntervalSeconds) / 60).toFixed(1)
    throw new Error(
      `Apify run ${run.id} for ${actorId} did not finish within ${maxPolls} polls (~${waitedMinutes}min) - last status ${status}`
    )
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run ${run.id} for ${actorId} finished with status ${status}, not SUCCEEDED`)
  }

  return (await step.run('fetch-apify-dataset', () => getApifyRunDatasetItems<T>(run.id, apifyToken))) as T[]
}
