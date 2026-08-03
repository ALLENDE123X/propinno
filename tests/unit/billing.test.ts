import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Stripe SDK mock -------------------------------------------------------
const mockSubscriptionsCancel = vi.fn()
const mockSubscriptionsRetrieve = vi.fn()
vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      cancel: (...args: unknown[]) => mockSubscriptionsCancel(...args),
      retrieve: (...args: unknown[]) => mockSubscriptionsRetrieve(...args),
    },
  },
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// --- Drizzle db mock -------------------------------------------------------
// Reads:  db.select({...}).from(users).where(...).limit(1)  -> selectRows queue
// Writes: db.update(users).set({...}).where(...)            -> recorded in updates
const selectRows: unknown[][] = []
const updates: Record<string, unknown>[] = []

const mockLimit = vi.fn(async () => selectRows.shift() ?? [])
const mockSelectWhere = vi.fn(() => ({ limit: mockLimit }))
const mockFrom = vi.fn(() => ({ where: mockSelectWhere }))
const mockSelect = vi.fn(() => ({ from: mockFrom }))

const mockUpdateWhere = vi.fn(async () => undefined)
const mockSet = vi.fn((values: Record<string, unknown>) => {
  updates.push(values)
  return { where: mockUpdateWhere }
})
const mockUpdate = vi.fn(() => ({ set: mockSet }))

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...(args as [])),
    update: (...args: unknown[]) => mockUpdate(...(args as [])),
  },
}))

import {
  handleStripeWebhookEvent,
  cancelStripeSubscription,
  subscriptionIdFromInvoice,
  planDays,
} from '@/lib/billing'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUB_ID = 'sub_test_123'
const CUSTOMER_ID = 'cus_test_123'

/** A subscription item period end, in unix seconds. */
function periodEndSeconds(daysFromNow: number): number {
  return Math.floor(Date.now() / 1000) + daysFromNow * 24 * 60 * 60
}

function subscriptionWithPeriodEnd(days: number, status = 'active') {
  return { id: SUB_ID, status, items: { data: [{ current_period_end: periodEndSeconds(days) }] } }
}

// Minimal event shapes — the handlers only read the fields asserted here, and
// casting keeps the tests readable without constructing full Stripe objects.
/* eslint-disable @typescript-eslint/no-explicit-any */
function event(type: string, object: unknown): any {
  return { type, data: { object } }
}

beforeEach(() => {
  vi.clearAllMocks()
  selectRows.length = 0
  updates.length = 0
  mockSubscriptionsRetrieve.mockResolvedValue(subscriptionWithPeriodEnd(30))
  mockSubscriptionsCancel.mockResolvedValue({ id: SUB_ID, status: 'canceled' })
})

describe('planDays', () => {
  it('maps plans to their billing period length', () => {
    expect(planDays('pass_30')).toBe(30)
    expect(planDays('pass_90')).toBe(90)
    expect(planDays(null)).toBe(30)
  })
})

describe('subscriptionIdFromInvoice', () => {
  it('reads the subscription from invoice.parent.subscription_details (dahlia API shape)', () => {
    const invoice = { parent: { subscription_details: { subscription: SUB_ID } } } as any
    expect(subscriptionIdFromInvoice(invoice)).toBe(SUB_ID)
  })

  it('unwraps an expanded subscription object', () => {
    const invoice = { parent: { subscription_details: { subscription: { id: SUB_ID } } } } as any
    expect(subscriptionIdFromInvoice(invoice)).toBe(SUB_ID)
  })

  it('returns null for a non-subscription invoice', () => {
    expect(subscriptionIdFromInvoice({ parent: null } as any)).toBeNull()
    expect(subscriptionIdFromInvoice({} as any)).toBeNull()
  })
})

describe('cancelStripeSubscription', () => {
  it('cancels immediately', async () => {
    await cancelStripeSubscription(SUB_ID)
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith(SUB_ID)
  })

  it('is idempotent when the subscription no longer exists', async () => {
    mockSubscriptionsCancel.mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }))
    await expect(cancelStripeSubscription(SUB_ID)).resolves.toBeUndefined()
  })

  it('is idempotent when the subscription is already canceled', async () => {
    mockSubscriptionsCancel.mockRejectedValue(new Error('cannot be canceled'))
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionWithPeriodEnd(30, 'canceled'))
    await expect(cancelStripeSubscription(SUB_ID)).resolves.toBeUndefined()
  })

  it('RETHROWS when the subscription is still live — callers must not record "canceled"', async () => {
    mockSubscriptionsCancel.mockRejectedValue(new Error('Stripe is down'))
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionWithPeriodEnd(30, 'active'))
    await expect(cancelStripeSubscription(SUB_ID)).rejects.toThrow('Stripe is down')
  })
})

describe('checkout.session.completed', () => {
  it('activates the user and stores the Stripe customer + subscription ids', async () => {
    await handleStripeWebhookEvent(event('checkout.session.completed', {
      id: 'cs_1',
      client_reference_id: USER_ID,
      metadata: { plan: 'pass_90' },
      subscription: SUB_ID,
      customer: CUSTOMER_ID,
    }))

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      status: 'active',
      plan: 'pass_90',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    })
    // Without a stored subscription id there would be no way to cancel later.
    expect(updates[0].stripeSubscriptionId).toBe(SUB_ID)
  })

  it('uses Stripe’s authoritative period end as the access expiry', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionWithPeriodEnd(90))
    await handleStripeWebhookEvent(event('checkout.session.completed', {
      id: 'cs_1', client_reference_id: USER_ID, metadata: { plan: 'pass_90' },
      subscription: SUB_ID, customer: CUSTOMER_ID,
    }))
    const expiry = updates[0].accessExpiresAt as Date
    const daysOut = (expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(daysOut).toBeGreaterThan(89)
    expect(daysOut).toBeLessThan(91)
  })

  it('falls back to plan length when Stripe cannot be read', async () => {
    mockSubscriptionsRetrieve.mockRejectedValue(new Error('network'))
    await handleStripeWebhookEvent(event('checkout.session.completed', {
      id: 'cs_1', client_reference_id: USER_ID, metadata: { plan: 'pass_30' },
      subscription: SUB_ID, customer: CUSTOMER_ID,
    }))
    const expiry = updates[0].accessExpiresAt as Date
    const daysOut = (expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(daysOut).toBeGreaterThan(29)
    expect(daysOut).toBeLessThan(31)
  })

  it('does nothing without a client_reference_id', async () => {
    await handleStripeWebhookEvent(event('checkout.session.completed', { id: 'cs_1', client_reference_id: null }))
    expect(updates).toHaveLength(0)
  })
})

describe('invoice.payment_succeeded (renewal)', () => {
  const renewalInvoice = {
    id: 'in_1',
    billing_reason: 'subscription_cycle',
    customer: CUSTOMER_ID,
    parent: { subscription_details: { subscription: SUB_ID } },
  }

  it('extends access on a real renewal cycle', async () => {
    selectRows.push([{ id: USER_ID, status: 'active', plan: 'pass_30', accessExpiresAt: new Date(), stripeSubscriptionId: SUB_ID }])
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionWithPeriodEnd(30))

    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ status: 'active' })
    const expiry = updates[0].accessExpiresAt as Date
    expect(expiry.getTime()).toBeGreaterThan(Date.now())
  })

  it('IGNORES the first invoice of a new subscription (already handled at checkout)', async () => {
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', {
      ...renewalInvoice, billing_reason: 'subscription_create',
    }))
    expect(updates).toHaveLength(0)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('is idempotent on duplicate delivery — absolute period end, not additive', async () => {
    const fixedEnd = subscriptionWithPeriodEnd(30)
    mockSubscriptionsRetrieve.mockResolvedValue(fixedEnd)

    selectRows.push([{ id: USER_ID, status: 'active', plan: 'pass_30', accessExpiresAt: new Date(), stripeSubscriptionId: SUB_ID }])
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))
    selectRows.push([{ id: USER_ID, status: 'active', plan: 'pass_30', accessExpiresAt: updates[0].accessExpiresAt as Date, stripeSubscriptionId: SUB_ID }])
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))

    expect(updates).toHaveLength(2)
    expect((updates[1].accessExpiresAt as Date).getTime()).toBe((updates[0].accessExpiresAt as Date).getTime())
  })

  it('reactivates a user whose access had lapsed but whose payment just succeeded', async () => {
    selectRows.push([{ id: USER_ID, status: 'expired', plan: 'pass_30', accessExpiresAt: new Date(Date.now() - 86400000), stripeSubscriptionId: SUB_ID }])
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))
    expect(updates[0]).toMatchObject({ status: 'active' })
  })

  it('never resurrects a user who marked "found a place" — cancels the leaked subscription instead', async () => {
    selectRows.push([{ id: USER_ID, status: 'done', plan: 'pass_30', accessExpiresAt: new Date(), stripeSubscriptionId: SUB_ID }])

    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith(SUB_ID)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({ stripeSubscriptionId: null })
    expect(updates[0].status).toBeUndefined()
  })

  it('falls back to customer lookup when the subscription id is unknown to us', async () => {
    selectRows.push([]) // no match by subscription id
    selectRows.push([{ id: USER_ID, status: 'active', plan: 'pass_90', accessExpiresAt: new Date(), stripeSubscriptionId: null }])

    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ status: 'active', stripeSubscriptionId: SUB_ID })
  })

  it('does not write anything when no user matches', async () => {
    selectRows.push([])
    selectRows.push([])
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))
    expect(updates).toHaveLength(0)
  })
})

describe('customer.subscription.deleted', () => {
  it('expires the user and clears the stored subscription id', async () => {
    selectRows.push([{ id: USER_ID, status: 'active', plan: 'pass_30', accessExpiresAt: new Date(), stripeSubscriptionId: SUB_ID }])

    await handleStripeWebhookEvent(event('customer.subscription.deleted', { id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled' }))

    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({ status: 'expired', stripeSubscriptionId: null })
  })

  it('does NOT stomp a "done" user back to expired', async () => {
    selectRows.push([{ id: USER_ID, status: 'done', plan: 'pass_30', accessExpiresAt: new Date(), stripeSubscriptionId: SUB_ID }])

    await handleStripeWebhookEvent(event('customer.subscription.deleted', { id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled' }))

    expect(updates[0]).toEqual({ status: 'done', stripeSubscriptionId: null })
  })

  it('does not write anything when no user matches', async () => {
    selectRows.push([])
    selectRows.push([])
    await handleStripeWebhookEvent(event('customer.subscription.deleted', { id: SUB_ID, customer: CUSTOMER_ID }))
    expect(updates).toHaveLength(0)
  })
})

describe('unhandled event types', () => {
  it('are a no-op, not a crash', async () => {
    await expect(handleStripeWebhookEvent(event('payment_intent.succeeded', {}))).resolves.toBeUndefined()
    expect(updates).toHaveLength(0)
  })
})
