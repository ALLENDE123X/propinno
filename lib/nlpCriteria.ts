import OpenAI from 'openai'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

// AH-020 natural-language search input.
//
// Parses a subscriber's free-text apartment description ("2BR under $4500 in
// the Mission or Hayes Valley, dog friendly, in-unit laundry") into the
// structured fields the onboarding criteria form already collects.
//
// Migrated from Anthropic/Claude to OpenAI (2026-07-18): the original
// implementation called Claude via ANTHROPIC_API_KEY, but only
// OPENAI_API_KEY was ever provisioned in Vercel Production - the feature had
// been silently non-functional in production since it shipped (confirmed via
// `vercel env ls production` showing no ANTHROPIC_API_KEY at all). Rather
// than ask for a new Anthropic key, this module was rewritten to call OpenAI
// instead, matching the key that's actually deployed.
//
// ── Design ──
// Uses forced tool-use (structured extraction via OpenAI's function-calling
// API), not free-text parsing: the call is constrained to a single tool
// (`tool_choice`) whose `parameters` schema matches the fields we want, so
// the model returns a parsed object rather than prose we'd have to
// regex/JSON.parse from freeform text. The result is then re-validated with
// zod before it's ever handed back to the client or written anywhere - the
// tool-call arguments are untrusted model output derived from untrusted user
// input, and get treated that way. Value domains here intentionally mirror
// lib/db/schema.ts's `criteria` table (see its own comment) and
// app/api/auth/verify-otp/route.ts's zod schema for pets/laundry/commuteMode,
// rather than inventing a parallel domain.
//
// ── What this does NOT do ──
// It does not geocode the commute address or compute a commute isochrone -
// that already happens exactly once, at criteria-set time, in
// app/api/auth/verify-otp/route.ts's existing call to
// lib/commute.ts's computeCommuteIsochrone() (see that module's header
// comment for why it must stay a single call site). Geocoding here too would
// duplicate that work and burn a Mapbox call for an address the user might
// still edit in the review step before submitting. This module only extracts
// the raw commuteAddress/commuteMaxMinutes/commuteMode fields, exactly the
// shape the onboarding form's own commute inputs already produce - the
// existing verify-otp flow computes/caches the isochrone unchanged once the
// user reviews, edits, and submits the form.
//
// ── Fails closed, never crashes onboarding ──
// Three distinct non-throwing failure modes, all returned as
// `{ success: false, reason, message }`: 'not_configured' (OPENAI_API_KEY
// unset - same "clear unavailable state, not a broken feature" pattern as
// NEXT_PUBLIC_MAPBOX_TOKEN in components/dashboard-map.tsx, adapted for a
// secret that can only be checked server-side), 'invalid_response' (the
// model's output didn't parse/validate, returned no tool call at all, or the
// tool-call arguments weren't valid JSON), and 'api_error' (network/API
// failure). The caller (app/api/onboarding/parse-criteria/route.ts) maps
// these to HTTP statuses; the onboarding form falls back to manual entry
// either way - it never auto-submits on the user's behalf regardless of
// outcome.
//
// ── Privacy ──
// The user's raw description text is sent to exactly one place (the OpenAI
// API call below) and is never logged, never attached to Sentry context, and
// never persisted - only the validated structured output is used, by the
// caller, to populate the review form.

const SYSTEM_PROMPT = `You extract structured apartment-search criteria for San Francisco rental listings from a user's free-text description.

Call the extract_apartment_criteria tool with only the fields the text actually supports - do not guess, invent, or default a value the user didn't express. Omit any field with no signal in the text.

Rules:
- priceMin/priceMax are monthly rent in US dollars.
- bedsMin/bedsMax: use 0 for a studio.
- bathsMin/bathsMax: only set if the user expresses a bathroom-count preference (e.g. "2 bath", "at least 1.5 baths"). Half-baths (e.g. 1.5) are valid and common.
- neighborhoods must be real San Francisco neighborhoods only (e.g. Mission, Marina, Hayes Valley, SoMa, Nob Hill, Castro, Pacific Heights, Sunset, Richmond, Bernal Heights, Noe Valley, North Beach). Never include neighborhoods from other cities.
- zips must be 5-digit US zip codes explicitly mentioned in the text.
- pets: only set if the user asks for pet-friendly housing. Use 'cats_and_dogs' if both or an unspecified pet type is mentioned.
- laundry: only set if the user mentions a laundry preference.
- commuteAddress/commuteMaxMinutes/commuteMode: only set if the user describes an actual commute constraint (a workplace, a destination, or an explicit "X minute commute"). Do not set these for a general location preference that's already captured by neighborhoods/zips.`

const EXTRACT_TOOL_NAME = 'extract_apartment_criteria'

// OpenAI's Chat Completions function-calling shape wraps the schema in
// `{type: 'function', function: {name, description, parameters}}` - unlike
// Anthropic's flatter `{name, description, input_schema}`. `parameters` here
// is otherwise the same JSON Schema shape the original Anthropic tool used.
const EXTRACT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: EXTRACT_TOOL_NAME,
    description:
      "Report the structured SF apartment search criteria extracted from the user's description.",
    parameters: {
      type: 'object',
      properties: {
        priceMin: { type: 'integer', description: 'Minimum monthly rent in USD, if mentioned.' },
        priceMax: { type: 'integer', description: 'Maximum monthly rent in USD, if mentioned.' },
        bedsMin: { type: 'number', description: 'Minimum bedrooms. Use 0 for studio.' },
        bedsMax: { type: 'number', description: 'Maximum bedrooms. Use 0 for studio.' },
        bathsMin: { type: 'number', description: 'Minimum bathrooms, only if the user expresses a bathroom preference. Half-baths (e.g. 1.5) are valid.' },
        bathsMax: { type: 'number', description: 'Maximum bathrooms, only if the user expresses a bathroom preference. Half-baths (e.g. 1.5) are valid.' },
        neighborhoods: {
          type: 'array',
          items: { type: 'string' },
          description: 'Real San Francisco neighborhood names mentioned. Empty array if none.',
        },
        zips: {
          type: 'array',
          items: { type: 'string' },
          description: '5-digit zip codes explicitly mentioned. Empty array if none.',
        },
        pets: {
          type: 'string',
          enum: ['cats', 'dogs', 'cats_and_dogs'],
          description: 'Pet requirement, only if the user asks for pet-friendly housing.',
        },
        laundry: {
          type: 'string',
          enum: ['in_unit', 'on_site'],
          description: 'Laundry requirement, only if the user mentions a laundry preference.',
        },
        commuteAddress: {
          type: 'string',
          description: 'Workplace or commute destination, only if the user describes a commute constraint.',
        },
        commuteMaxMinutes: {
          type: 'integer',
          description: 'Maximum acceptable commute time in minutes, only if the user specifies one.',
        },
        commuteMode: {
          type: 'string',
          enum: ['transit', 'bike', 'drive'],
          description: 'Commute mode the user mentions.',
        },
      },
      required: ['neighborhoods', 'zips'],
    },
  },
}

// Reasonable sanity bounds, not a strict business-rule engine - this data is
// user-review-before-submit, not written straight to the DB. Ranges mirror
// app/api/auth/verify-otp/route.ts's own zod schema where a directly
// analogous field exists (commuteMaxMinutes: 1-180, pets/laundry/commuteMode
// enums). Neighborhoods/zips are validated for shape (not an exhaustive SF
// neighborhood whitelist, which would be brittle - the prompt above already
// steers the model to real SF neighborhoods, and this is a free-text form
// field downstream, not an enum column).
export const parsedCriteriaSchema = z
  .object({
    priceMin: z.number().int().min(0).max(50000).optional(),
    priceMax: z.number().int().min(0).max(50000).optional(),
    bedsMin: z.number().min(0).max(10).optional(),
    bedsMax: z.number().min(0).max(10).optional(),
    bathsMin: z.number().min(0).max(10).optional(),
    bathsMax: z.number().min(0).max(10).optional(),
    neighborhoods: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
    zips: z.array(z.string().regex(/^\d{5}$/, 'Zip must be 5 digits')).max(10).optional(),
    pets: z.enum(['cats', 'dogs', 'cats_and_dogs']).optional(),
    laundry: z.enum(['in_unit', 'on_site']).optional(),
    commuteAddress: z.string().trim().min(1).max(200).optional(),
    commuteMaxMinutes: z.number().int().min(1).max(180).optional(),
    commuteMode: z.enum(['transit', 'bike', 'drive']).optional(),
  })
  .refine(
    (data) => data.priceMin === undefined || data.priceMax === undefined || data.priceMin <= data.priceMax,
    { message: 'priceMin must not exceed priceMax', path: ['priceMin'] }
  )
  .refine(
    (data) => data.bedsMin === undefined || data.bedsMax === undefined || data.bedsMin <= data.bedsMax,
    { message: 'bedsMin must not exceed bedsMax', path: ['bedsMin'] }
  )
  .refine(
    (data) => data.bathsMin === undefined || data.bathsMax === undefined || data.bathsMin <= data.bathsMax,
    { message: 'bathsMin must not exceed bathsMax', path: ['bathsMin'] }
  )

export type ParsedCriteria = z.infer<typeof parsedCriteriaSchema>

export type ParseCriteriaResult =
  | { success: true; data: ParsedCriteria }
  | { success: false; reason: 'not_configured' | 'invalid_response' | 'api_error'; message: string }

const FALLBACK_MESSAGE = 'Please fill in the fields below manually.'

// The model may omit a field entirely (fine - zod treats it as undefined via
// .optional()) or, less commonly, send back null or an empty string for a
// field it considered but had no data for. Normalize both to "absent" before
// validation so those don't fail range/enum checks that only apply when a
// value is actually present.
function stripEmptyValues(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === '') continue
    // key comes from Object.entries() over the model's own tool-call
    // arguments, not user-controlled property access - the schema (below)
    // still fully validates every value before it's trusted anywhere.
    // eslint-disable-next-line security/detect-object-injection
    cleaned[key] = value
  }
  return cleaned
}

/**
 * Parses `description` (raw user free text) into structured onboarding
 * criteria via OpenAI tool-use, validates the result with zod, and never
 * throws - every failure mode returns a typed, user-safe result instead.
 */
export async function parseCriteriaFromText(description: string): Promise<ParseCriteriaResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logger.warn('NLP criteria parsing requested but OPENAI_API_KEY is not configured')
    return {
      success: false,
      reason: 'not_configured',
      message: `Natural language search isn't available right now. ${FALLBACK_MESSAGE}`,
    }
  }

  try {
    const client = new OpenAI({ apiKey })
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      // Simple, well-scoped structured extraction - a fast/cheap model is
      // the right fit, same reasoning as the original Claude call's
      // low-effort setting.
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'function', function: { name: EXTRACT_TOOL_NAME } },
    })

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0]
    // The SDK's ChatCompletionMessageToolCall type is a union of a
    // function-tool-call shape (with `.function.arguments`) and a "custom
    // tool" shape (no `.function`). We only ever declare a `type: 'function'`
    // tool above and force it via `tool_choice`, so a real response can only
    // ever come back as the function variant - this check narrows the type
    // accordingly rather than assuming it at the type level.
    if (!toolCall || toolCall.type !== 'function') {
      logger.warn(
        { finishReason: completion.choices[0]?.finish_reason },
        'NLP criteria parsing: no tool call in OpenAI response'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't understand that description. ${FALLBACK_MESSAGE}`,
      }
    }

    // Unlike Anthropic's tool_use.input (already a parsed object), OpenAI
    // returns function-call arguments as a raw JSON string - a real, if
    // rare, extra failure mode if the model ever emits malformed JSON.
    let rawInput: unknown
    try {
      rawInput = JSON.parse(toolCall.function.arguments)
    } catch (parseErr) {
      logger.warn({ err: parseErr }, 'NLP criteria parsing: tool call arguments were not valid JSON')
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't extract valid criteria from that description. ${FALLBACK_MESSAGE}`,
      }
    }

    const parsed = parsedCriteriaSchema.safeParse(stripEmptyValues(rawInput))
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        'NLP criteria parsing: validation failed'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't extract valid criteria from that description. ${FALLBACK_MESSAGE}`,
      }
    }

    return { success: true, data: parsed.data }
  } catch (err) {
    logger.error({ err }, 'NLP criteria parsing failed')
    Sentry.captureException(err, { extra: { context: 'parseCriteriaFromText' } })
    return {
      success: false,
      reason: 'api_error',
      message: `Something went wrong parsing your description. ${FALLBACK_MESSAGE}`,
    }
  }
}
