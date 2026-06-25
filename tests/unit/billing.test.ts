import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route'
import { limitRequest } from '@/lib/ratelimit'
import { stripe } from '@/lib/stripe'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'

vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))

vi.mock('@/lib/stripe', () => ({
  stripe: {
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  },
}))

const mocks = vi.hoisted(() => {
  const mockWhere = vi.fn()
  const mockSet = vi.fn(() => ({ where: mockWhere }))
  const mockUpdate = vi.fn(() => ({ set: mockSet }))
  return { mockWhere, mockSet, mockUpdate }
})

vi.mock('@/lib/db', () => ({
  db: {
    update: mocks.mockUpdate,
  },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

describe('Billing API Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
    process.env.STRIPE_PRICE_ID = 'price_test_123'
    vi.mocked(limitRequest).mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 })
  })


  describe('POST /api/webhooks/stripe', () => {
    it('returns 400 if signature is missing', async () => {
      const req = new Request('http://localhost/api/webhooks/stripe', { method: 'POST', body: 'test' })
      const res = await stripeWebhook(req)
      expect(res.status).toBe(400)
    })

    it('handles checkout.session.completed', async () => {
      const req = new Request('http://localhost/api/webhooks/stripe', { 
        method: 'POST', 
        body: 'test',
        headers: new Headers({ 'stripe-signature': 'test-sig' })
      })
      
      vi.mocked(stripe.webhooks.constructEvent).mockReturnValueOnce({
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: 'user_1',
            customer: 'cus_1',
            subscription: 'sub_1'
          }
        }
      } as unknown as Stripe.Event)

      const res = await stripeWebhook(req)
      expect(res.status).toBe(200)
      expect(mocks.mockUpdate).toHaveBeenCalledWith(users)
      expect(mocks.mockSet).toHaveBeenCalledWith({
        stripeSubscriptionStatus: 'active',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1'
      })
    })

    it('handles customer.subscription.updated', async () => {
      const req = new Request('http://localhost/api/webhooks/stripe', { 
        method: 'POST', 
        body: 'test',
        headers: new Headers({ 'stripe-signature': 'test-sig' })
      })
      
      vi.mocked(stripe.webhooks.constructEvent).mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            status: 'past_due'
          }
        }
      } as unknown as Stripe.Event)

      const res = await stripeWebhook(req)
      expect(res.status).toBe(200)
      expect(mocks.mockUpdate).toHaveBeenCalledWith(users)
      expect(mocks.mockSet).toHaveBeenCalledWith({
        stripeSubscriptionStatus: 'past_due',
      })
    })

    it('handles customer.subscription.deleted', async () => {
      const req = new Request('http://localhost/api/webhooks/stripe', { 
        method: 'POST', 
        body: 'test',
        headers: new Headers({ 'stripe-signature': 'test-sig' })
      })
      
      vi.mocked(stripe.webhooks.constructEvent).mockReturnValueOnce({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1'
          }
        }
      } as unknown as Stripe.Event)

      const res = await stripeWebhook(req)
      expect(res.status).toBe(200)
      expect(mocks.mockUpdate).toHaveBeenCalledWith(users)
      expect(mocks.mockSet).toHaveBeenCalledWith({
        stripeSubscriptionStatus: 'canceled',
      })
    })

    it('handles unhandled event types gracefully', async () => {
      const req = new Request('http://localhost/api/webhooks/stripe', { 
        method: 'POST', 
        body: 'test',
        headers: new Headers({ 'stripe-signature': 'test-sig' })
      })
      
      vi.mocked(stripe.webhooks.constructEvent).mockReturnValueOnce({
        type: 'some.unhandled.event',
        data: { object: {} }
      } as unknown as Stripe.Event)

      const res = await stripeWebhook(req)
      expect(res.status).toBe(200)
    })
  })
})
