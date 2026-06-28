import { expect, test, describe, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { getUserStatus, markFoundPlace } from '@/app/checkout/actions'
import { POST } from '@/app/api/webhooks/stripe/route'
import { stripe } from '@/lib/stripe'
import { db } from '@/lib/db'

// Mock dependencies
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue('127.0.0.1')
  })
}))

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
            phone: '+15551112222', 
            status: 'pending_payment' 
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
  })

  test('Server Action: getUserStatus', async () => {
    const user = await getUserStatus(testUserId)
    expect(user).not.toBeNull()
    expect(user?.status).toBe('pending_payment')
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue(mockEvent as any)

    const req = new Request('http://localhost:3000/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-signature' },
      body: 'test-body'
    })
    
    process.env.STRIPE_WEBHOOK_SECRET = 'test-secret'
    
    const res = await POST(req)
    expect(res.status).toBe(200)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((db.update as any)().set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        plan: 'pass_90',
        accessExpiresAt: expect.any(Date)
      })
    )
  })

  test('Server Action: markFoundPlace', async () => {
    const res = await markFoundPlace(testUserId)
    expect(res.success).toBe(true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((db.update as any)().set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'done'
      })
    )
  })
})
