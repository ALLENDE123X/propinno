import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  const runCalls: string[] = []
  return {
    run: vi.fn((name: string, fn: () => unknown) => {
      runCalls.push(name)
      return Promise.resolve(fn())
    }),
    sleep: vi.fn((name: string) => {
      sleepCalls.push(name)
      return Promise.resolve(undefined)
    }),
    sleepCalls,
    runCalls,
  }
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

  it('fails closed with a clear error rather than polling forever when maxPolls is exceeded', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: 'run-1', status: 'RUNNING' } }))
    const step = makeStep()
    await expect(runApifyActorAsync(step, 'some~actor', {}, { maxPolls: 2, pollIntervalSeconds: 1 })).rejects.toThrow(
      'Apify run run-1 for some~actor did not finish within 2 polls'
    )
    expect(step.sleepCalls).toEqual(['wait-for-apify-run-0', 'wait-for-apify-run-1'])
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
