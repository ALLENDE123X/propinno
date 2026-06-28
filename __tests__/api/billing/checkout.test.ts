import { expect, test, describe, vi, beforeEach } from 'vitest'
import { getUserStatus, markFoundPlace, createCheckoutSession } from '@/app/checkout/actions'
import { users } from '@/lib/db/schema'
import { POST } from '@/app/api/webhooks/stripe/route'
import { stripe } from '@/lib/stripe'
import { db } from '@/lib/db'
import type Stripe from 'stripe'

// Mock dependencies
vi.mock('next/headers', () => {
  const cookieGetMock = vi.fn().mockReturnValue({ value: '123e4567-e89b-12d3-a456-426614174000' })
  return {
    headers: vi.fn().mockResolvedValue({
      get: vi.fn().mockReturnValue('127.0.0.1')
    }),
    cookies: vi.fn().mockResolvedValue({
      get: cookieGetMock
    }),
    __cookieGetMock: cookieGetMock // Expose for testing if we want to mock no session
  }
})

vi.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn()
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' })
      }
    }
  }
}))

vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn().mockResolvedValue({ success: true })
}))

vi.mock('@/lib/db', () => {
  const mockDbUpdateSet = {
    where: vi.fn().mockResolvedValue([{ id: 'mock-user-id' }])
  }
  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ 
            id: 'mock-user-id', 
            status: 'pending_payment' 
            // Phone is omitted from select in the new action!
          }])
        })
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue(mockDbUpdateSet)
      }),
      __mockDbUpdateSet: mockDbUpdateSet // exposed for assertions
    }
  }
})

describe('Billing Checkout & Webhook', () => {
  const testUserId = '123e4567-e89b-12d3-a456-426614174000'

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_PRICE_30DAY = 'price_30'
    process.env.STRIPE_PRICE_90DAY = 'price_90'
  })

  test('Server Action: getUserStatus reads from cookie', async () => {
    const user = await getUserStatus()
    expect(user).not.toBeNull()
    expect(user?.status).toBe('pending_payment')
  })

  test('Server Action: createCheckoutSession creates stripe session', async () => {
    const res = await createCheckoutSession('pass_30')
    expect(res.url).toBe('https://checkout.stripe.com/test')
    
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_30', quantity: 1 }],
        client_reference_id: testUserId,
        metadata: { plan: 'pass_30' }
      })
    )
  })

  test('Webhook: Stripe checkout session completed for 90-day pass', async () => {
    const mockEvent = {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: testUserId,
          metadata: { plan: 'pass_90' }
        }
      }
    }

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue((mockEvent as unknown) as Stripe.Event)

    const req = new Request('http://localhost:3000/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-signature' },
      body: 'test-body'
    })
    
    process.env.STRIPE_WEBHOOK_SECRET = 'test-secret'
    
    const res = await POST(req)
    expect(res.status).toBe(200)

    expect(vi.mocked(db.update)(users).set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        plan: 'pass_90',
        accessExpiresAt: expect.any(Date)
      })
    )
  })

  test('Webhook: Stripe checkout session completed for 30-day pass', async () => {
    const mockEvent = {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: testUserId,
          metadata: { plan: 'pass_30' }
        }
      }
    }

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue((mockEvent as unknown) as Stripe.Event)

    const req = new Request('http://localhost:3000/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-signature' },
      body: 'test-body'
    })
    
    process.env.STRIPE_WEBHOOK_SECRET = 'test-secret'
    
    const res = await POST(req)
    expect(res.status).toBe(200)

    expect(vi.mocked(db.update)(users).set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        plan: 'pass_30',
        accessExpiresAt: expect.any(Date)
      })
    )
  })

  test('Server Action: markFoundPlace reads from cookie', async () => {
    const res = await markFoundPlace()
    expect(res.success).toBe(true)

    expect(vi.mocked(db.update)(users).set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'done'
      })
    )
  })

  test('Server Action: fails on rate limit', async () => {
    const { limitRequest } = await import('@/lib/ratelimit')
    vi.mocked(limitRequest).mockResolvedValueOnce({ success: false, limit: 5, remaining: 0, reset: 0 })
    
    await expect(createCheckoutSession('pass_30')).rejects.toThrow("Failed to start checkout process")
  })
})
