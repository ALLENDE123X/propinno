import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NonRetriableError } from 'inngest'
import { runApifyActorAsync } from '@/lib/apifyAsync'

const mockFetch = vi.fn()
global.fetch = mockFetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

// A step.run/step.sleep mock that just executes the callback / resolves
// immediately, matching the "step.run just runs its fn unless a test
// overrides a specific name" convention already used in
// tests/unit/twilioSender.test.ts / tests/unit/craigslistPoller.test.ts.
function makeStep() {
  const sleepCalls: string[] = []
  const sleepDurations: string[] = []
  const runCalls: string[] = []
  return {
    run: vi.fn((name: string, fn: () => unknown) => {
      runCalls.push(name)
      return Promise.resolve(fn())
    }),
    sleep: vi.fn((name: string, duration: string) => {
      sleepCalls.push(name)
      sleepDurations.push(duration)
      return Promise.resolve(undefined)
    }),
    sleepCalls,
    sleepDurations,
    runCalls,
  }
}

/** Total wall-clock seconds a list of Inngest duration strings (`'10s'`) adds up to. */
function totalWaitSeconds(durations: string[]): number {
  return durations.reduce((sum, d) => sum + Number(d.replace('s', '')), 0)
}

const SAMPLE_ITEMS = [{ id: 'item-1' }, { id: 'item-2' }]

describe('runApifyActorAsync', () => {
  const ORIGINAL_TOKEN = process.env.APIFY_API_TOKEN

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.APIFY_API_TOKEN = 'test-token'
  })

  afterEach(() => {
    process.env.APIFY_API_TOKEN = ORIGINAL_TOKEN
  })

  it('throws if APIFY_API_TOKEN is not set', async () => {
    delete process.env.APIFY_API_TOKEN
    const step = makeStep()
    await expect(runApifyActorAsync(step, 'some~actor', {})).rejects.toThrow('APIFY_API_TOKEN')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('starts the run via POST to /v2/acts/{actorId}/runs with the given input as the body', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ITEMS))

    const step = makeStep()
    await runApifyActorAsync(step, 'some~actor', { maxItems: 5 })

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.apify.com/v2/acts/some~actor/runs?token=test-token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxItems: 5 }),
      })
    )
  })

  it('throws when starting the run returns a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('Server error', false, 500))
    const step = makeStep()
    await expect(runApifyActorAsync(step, 'some~actor', {})).rejects.toThrow('Apify start-run for some~actor returned 500')
  })

  it('fetches the dataset immediately (no polling) when the start response is already terminal', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ITEMS))

    const step = makeStep()
    const items = await runApifyActorAsync(step, 'some~actor', {})

    expect(items).toEqual(SAMPLE_ITEMS)
    expect(step.sleep).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://api.apify.com/v2/actor-runs/run-1/dataset/items?token=test-token')
  })

  it('polls (via step.sleep, not a blocking loop) until the run reaches a terminal status', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'RUNNING' } })) // start
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'RUNNING' } })) // poll attempt 0
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } })) // poll attempt 1
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ITEMS)) // dataset fetch

    const step = makeStep()
    const items = await runApifyActorAsync(step, 'some~actor', {}, { pollIntervalSeconds: 5 })

    expect(items).toEqual(SAMPLE_ITEMS)
    expect(step.sleepCalls).toEqual(['wait-for-apify-run-0', 'wait-for-apify-run-1'])
    expect(step.runCalls).toEqual(['start-apify-run', 'check-apify-run-status-0', 'check-apify-run-status-1', 'fetch-apify-dataset'])
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://api.apify.com/v2/actor-runs/run-1?token=test-token')
    // Every step.sleep call uses the configured interval, formatted for Inngest's duration-string input.
    expect(step.sleep).toHaveBeenCalledWith('wait-for-apify-run-0', '5s')
  })

  it('throws (does not silently swallow) when the run finishes with a non-SUCCEEDED terminal status', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'FAILED' } }))
    const step = makeStep()
    await expect(runApifyActorAsync(step, 'some~actor', {})).rejects.toThrow(
      'Apify run run-1 for some~actor finished with status FAILED, not SUCCEEDED'
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('fails closed with a clear error rather than polling forever when the wait budget is exhausted', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: 'run-1', status: 'RUNNING' } }))
    const step = makeStep()
    await expect(
      runApifyActorAsync(step, 'some~actor', {}, { maxWaitSeconds: 2, pollIntervalSeconds: 1 })
    ).rejects.toThrow('Apify run run-1 for some~actor did not finish within 2 polls')
    expect(step.sleepCalls).toEqual(['wait-for-apify-run-0', 'wait-for-apify-run-1'])
  })

  // ---- issue #78: the wait budget that abandoned a run which then SUCCEEDED ----

  it('leaves the first 5 minutes of polling unchanged, then backs off to 60s out to a 22min ceiling', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: 'run-1', status: 'RUNNING' } }))
    const step = makeStep()

    await expect(runApifyActorAsync(step, 'some~actor', {})).rejects.toThrow()

    // Fast phase: 300s of 10s polls, byte-identical to the pre-fix behaviour,
    // so no healthy run's data latency regresses.
    expect(step.sleepDurations.slice(0, 30)).toEqual(Array(30).fill('10s'))
    // Slow phase: everything past the fast window backs off to 60s.
    expect(step.sleepDurations.slice(30)).toEqual(Array(17).fill('60s'))
    expect(totalWaitSeconds(step.sleepDurations)).toBe(1320)
    // 47 polls to cover 22 minutes; a flat 10s interval would have cost 132.
    expect(step.sleepDurations).toHaveLength(47)
  })

  it('waits long enough to cover the real 923s incident run (Apify run 8NAHaL2NsPHaREOCe)', async () => {
    // The production run that triggered issue #78 SUCCEEDED after 922.99s.
    // The old 30-poll/300s budget gave up on it at 300s; the new budget must
    // still be polling when a run of that length finishes.
    const INCIDENT_RUN_SECONDS = 922.99
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: 'run-1', status: 'RUNNING' } }))
    const step = makeStep()

    await expect(runApifyActorAsync(step, 'some~actor', {})).rejects.toThrow()

    expect(totalWaitSeconds(step.sleepDurations)).toBeGreaterThan(INCIDENT_RUN_SECONDS)
    // ...and the poll that would have observed it lands with real headroom,
    // not right on the edge of the ceiling.
    const pollsBeforeIncidentElapsed = step.sleepDurations.findIndex(
      (_, i) => totalWaitSeconds(step.sleepDurations.slice(0, i + 1)) >= INCIDENT_RUN_SECONDS
    )
    expect(pollsBeforeIncidentElapsed).toBeGreaterThanOrEqual(0)
    expect(step.sleepDurations.length - pollsBeforeIncidentElapsed).toBeGreaterThan(5)
  })

  it('returns the dataset for a run that only reaches SUCCEEDED during the slow (backed-off) phase', async () => {
    // 35 polls of RUNNING puts the run well past the 300s fast window, which
    // is exactly the case the old budget could never reach.
    for (let i = 0; i < 36; i += 1) {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'RUNNING' } }))
    }
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ITEMS))

    const step = makeStep()
    const items = await runApifyActorAsync(step, 'some~actor', {})

    expect(items).toEqual(SAMPLE_ITEMS)
    expect(totalWaitSeconds(step.sleepDurations)).toBeGreaterThan(300)
    expect(step.runCalls).toContain('fetch-apify-dataset')
  })

  it('marks budget exhaustion non-retriable, since Inngest replays memoized steps to the identical failure', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: 'run-1', status: 'RUNNING' } }))
    const step = makeStep()
    await expect(
      runApifyActorAsync(step, 'some~actor', {}, { maxWaitSeconds: 2, pollIntervalSeconds: 1 })
    ).rejects.toBeInstanceOf(NonRetriableError)
  })

  it('marks a non-SUCCEEDED terminal status non-retriable for the same memoization reason', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'ABORTED' } }))
    const step = makeStep()
    await expect(runApifyActorAsync(step, 'some~actor', {})).rejects.toBeInstanceOf(NonRetriableError)
  })

  it('keeps errors raised inside a step retryable, because step-level retries genuinely help there', async () => {
    // A non-ok HTTP response is a transient network-layer failure thrown
    // inside step.run - Inngest retries that step on its own, so it must NOT
    // be swept up in the non-retriable treatment above.
    mockFetch.mockResolvedValueOnce(jsonResponse('Server error', false, 500))
    const step = makeStep()
    await expect(runApifyActorAsync(step, 'some~actor', {})).rejects.not.toBeInstanceOf(NonRetriableError)
  })

  it('throws when the dataset-items fetch returns a non-ok response', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } }))
      .mockResolvedValueOnce(jsonResponse('boom', false, 503))
    const step = makeStep()
    await expect(runApifyActorAsync(step, 'some~actor', {})).rejects.toThrow(
      'Apify get-dataset-items for run run-1 returned 503'
    )
  })
})
