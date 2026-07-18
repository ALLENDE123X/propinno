import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'

const mockCreate = vi.fn()

// Mirrors tests/unit/twilioSender.test.ts's pattern for mocking a
// class-based SDK client: the module's default export is a constructor;
// `new OpenAI(...)` must return an object exposing
// `.chat.completions.create`.
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } }
  },
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// Imported after the mocks above so the module under test picks up the
// mocked openai constructor.
import { parseCriteriaFromText, parsedCriteriaSchema } from '@/lib/nlpCriteria'

function toolCallResponse(input: Record<string, unknown>) {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'extract_apartment_criteria', arguments: JSON.stringify(input) },
            },
          ],
        },
      },
    ],
  }
}

describe('parsedCriteriaSchema', () => {
  it('accepts a fully valid payload', () => {
    const result = parsedCriteriaSchema.safeParse({
      priceMin: 2000,
      priceMax: 4500,
      bedsMin: 1,
      bedsMax: 2,
      bathsMin: 1,
      bathsMax: 2,
      neighborhoods: ['Mission', 'Hayes Valley'],
      zips: ['94110'],
      pets: 'dogs',
      laundry: 'in_unit',
      commuteAddress: '1 Market St, San Francisco, CA',
      commuteMaxMinutes: 30,
      commuteMode: 'transit',
    })
    expect(result.success).toBe(true)
  })

  it('accepts an empty object (nothing extracted)', () => {
    expect(parsedCriteriaSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a negative price', () => {
    expect(parsedCriteriaSchema.safeParse({ priceMin: -500 }).success).toBe(false)
  })

  it('rejects an unreasonably large price', () => {
    expect(parsedCriteriaSchema.safeParse({ priceMax: 500000 }).success).toBe(false)
  })

  it('rejects priceMin greater than priceMax', () => {
    const result = parsedCriteriaSchema.safeParse({ priceMin: 5000, priceMax: 3000 })
    expect(result.success).toBe(false)
  })

  it('rejects an unreasonable beds count', () => {
    expect(parsedCriteriaSchema.safeParse({ bedsMax: 50 }).success).toBe(false)
  })

  it('rejects bedsMin greater than bedsMax', () => {
    expect(parsedCriteriaSchema.safeParse({ bedsMin: 3, bedsMax: 1 }).success).toBe(false)
  })

  it('accepts studio as bedsMin/bedsMax of 0', () => {
    expect(parsedCriteriaSchema.safeParse({ bedsMin: 0, bedsMax: 0 }).success).toBe(true)
  })

  it('accepts a half-bath value for bathsMin/bathsMax', () => {
    expect(parsedCriteriaSchema.safeParse({ bathsMin: 1.5, bathsMax: 2.5 }).success).toBe(true)
  })

  it('rejects an unreasonable baths count', () => {
    expect(parsedCriteriaSchema.safeParse({ bathsMax: 50 }).success).toBe(false)
  })

  it('rejects a negative baths count', () => {
    expect(parsedCriteriaSchema.safeParse({ bathsMin: -1 }).success).toBe(false)
  })

  it('rejects bathsMin greater than bathsMax', () => {
    expect(parsedCriteriaSchema.safeParse({ bathsMin: 3, bathsMax: 1 }).success).toBe(false)
  })

  it('rejects a pets value outside the DB value domain', () => {
    expect(parsedCriteriaSchema.safeParse({ pets: 'yes' }).success).toBe(false)
  })

  it('rejects a laundry value outside the DB value domain', () => {
    expect(parsedCriteriaSchema.safeParse({ laundry: 'hookups' }).success).toBe(false)
  })

  it('rejects a commuteMode value outside the DB value domain', () => {
    expect(parsedCriteriaSchema.safeParse({ commuteMode: 'walk' }).success).toBe(false)
  })

  it('rejects a malformed zip code', () => {
    expect(parsedCriteriaSchema.safeParse({ zips: ['9411'] }).success).toBe(false)
  })

  it('rejects commuteMaxMinutes out of the 1-180 range', () => {
    expect(parsedCriteriaSchema.safeParse({ commuteMaxMinutes: 0 }).success).toBe(false)
    expect(parsedCriteriaSchema.safeParse({ commuteMaxMinutes: 500 }).success).toBe(false)
  })

  it('rejects a missing/malformed shape entirely', () => {
    expect(parsedCriteriaSchema.safeParse(null).success).toBe(false)
    expect(parsedCriteriaSchema.safeParse('not an object').success).toBe(false)
  })
})

describe('parseCriteriaFromText', () => {
  const ORIGINAL_ENV = process.env.OPENAI_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = ORIGINAL_ENV
  })

  it('fails gracefully with reason "not_configured" when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY
    const result = await parseCriteriaFromText('2BR under $4000 in the Mission')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('not_configured')
      expect(result.message).toMatch(/manually/i)
    }
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('parses a realistic description into validated criteria', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(
      toolCallResponse({
        priceMax: 4500,
        bedsMin: 2,
        bedsMax: 2,
        neighborhoods: ['Mission', 'Hayes Valley'],
        zips: [],
        pets: 'dogs',
        laundry: 'in_unit',
      })
    )

    const result = await parseCriteriaFromText(
      '2BR under $4500 in the Mission or Hayes Valley, dog friendly, in-unit laundry'
    )

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.priceMax).toBe(4500)
      expect(result.data.bedsMin).toBe(2)
      expect(result.data.neighborhoods).toEqual(['Mission', 'Hayes Valley'])
      expect(result.data.pets).toBe('dogs')
      expect(result.data.laundry).toBe('in_unit')
    }

    // Forced tool-use, not free-text parsing.
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.tool_choice).toEqual({ type: 'function', function: { name: 'extract_apartment_criteria' } })
    expect(callArgs.model).toBe('gpt-4o-mini')
  })

  it('parses a bathroom preference (AH-024), including a half-bath value, alongside beds/price', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(
      toolCallResponse({
        priceMax: 5000,
        bedsMin: 2,
        bathsMin: 1.5,
        bathsMax: 2,
        neighborhoods: [],
        zips: [],
      })
    )

    const result = await parseCriteriaFromText('2BR with at least 1.5 baths under $5000')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.bathsMin).toBe(1.5)
      expect(result.data.bathsMax).toBe(2)
    }

    // extract_apartment_criteria's parameters schema exposes
    // bathsMin/bathsMax for consistency with beds/price, per AH-024's scope.
    const callArgs = mockCreate.mock.calls[0][0]
    const tool = callArgs.tools[0]
    expect(tool.function.parameters.properties).toHaveProperty('bathsMin')
    expect(tool.function.parameters.properties).toHaveProperty('bathsMax')
  })

  it('does not set a baths preference when the text has no bathroom signal', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(
      toolCallResponse({ priceMax: 3000, neighborhoods: [], zips: [] })
    )

    const result = await parseCriteriaFromText('under $3000')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.bathsMin).toBeUndefined()
      expect(result.data.bathsMax).toBeUndefined()
    }
  })

  it('treats null/empty-string fields from the model as absent rather than failing validation', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(
      toolCallResponse({
        priceMin: null,
        priceMax: 3000,
        neighborhoods: [],
        zips: [],
        pets: '',
      })
    )

    const result = await parseCriteriaFromText('under $3000')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.priceMin).toBeUndefined()
      expect(result.data.pets).toBeUndefined()
      expect(result.data.priceMax).toBe(3000)
    }
  })

  it('fails gracefully when the model returns an out-of-range value', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(
      toolCallResponse({ priceMin: -500, neighborhoods: [], zips: [] })
    )

    const result = await parseCriteriaFromText('a weird description')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully when OpenAI does not return a tool call', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { content: 'huh?', tool_calls: undefined } }],
    })

    const result = await parseCriteriaFromText('gibberish')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully when the tool call arguments are not valid JSON', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'extract_apartment_criteria', arguments: '{not valid json' } },
            ],
          },
        },
      ],
    })

    const result = await parseCriteriaFromText('gibberish')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully and reports to Sentry on an API/network error, without crashing', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockRejectedValueOnce(new Error('network down'))

    const result = await parseCriteriaFromText('2BR in SoMa')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('api_error')
    expect(Sentry.captureException).toHaveBeenCalled()
  })

  it('never logs or forwards the raw user description text', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const secretDescription = 'my very private search description, do not log me'
    mockCreate.mockRejectedValueOnce(new Error('boom'))

    await parseCriteriaFromText(secretDescription)

    const loggerCalls = [...vi.mocked(logger.error).mock.calls, ...vi.mocked(logger.warn).mock.calls]
    for (const call of loggerCalls) {
      expect(JSON.stringify(call)).not.toContain(secretDescription)
    }
    const sentryCalls = vi.mocked(Sentry.captureException).mock.calls
    for (const call of sentryCalls) {
      expect(JSON.stringify(call)).not.toContain(secretDescription)
    }
  })
})
