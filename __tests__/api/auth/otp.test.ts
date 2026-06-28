import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST as sendOtp } from '@/app/api/auth/send-otp/route'
import { POST as verifyOtp } from '@/app/api/auth/verify-otp/route'

vi.mock('next/headers', () => {
  return {
    headers: vi.fn().mockResolvedValue({
      get: vi.fn().mockReturnValue('127.0.0.1')
    }),
    cookies: vi.fn().mockResolvedValue({
      set: vi.fn()
    })
  }
})

vi.mock('twilio', () => {
  return {
    default: () => ({
      verify: {
        v2: {
          services: () => ({
            verifications: {
              create: vi.fn().mockResolvedValue({ status: 'pending' })
            },
            verificationChecks: {
              create: vi.fn().mockImplementation((args) => {
                if (args.code === '123456') {
                  return Promise.resolve({ status: 'approved' })
                }
                return Promise.resolve({ status: 'pending' })
              })
            }
          })
        }
      }
    })
  }
})

vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn().mockResolvedValue({ success: true })
}))

vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn().mockImplementation(async () => {
      // Mock transaction inserting user
      return { id: 'mock-user-id' }
    })
  }
}))

describe('OTP APIs', () => {
  beforeEach(() => {
    process.env.TWILIO_VERIFY_SERVICE_SID = 'mock-sid'
    vi.clearAllMocks()
  })

  it('send-otp should succeed with valid phone', async () => {
    const req = new Request('http://localhost/api/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ phone: '+14155550123' }),
      headers: { 'Content-Type': 'application/json' }
    })
    
    const res = await sendOtp(req)
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
  })

  it('send-otp should fail with invalid phone', async () => {
    const req = new Request('http://localhost/api/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ phone: '123' }), // Too short
      headers: { 'Content-Type': 'application/json' }
    })
    
    const res = await sendOtp(req)
    expect(res.status).toBe(500) // Error caught by Sentry and returned 500
  })

  it('verify-otp should succeed with correct code', async () => {
    const req = new Request('http://localhost/api/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ 
        phone: '+14155550123', 
        code: '123456',
        criteria: { priceMax: 2000 }
      }),
      headers: { 'Content-Type': 'application/json' }
    })
    
    const res = await verifyOtp(req)
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.userId).toBe('mock-user-id')
  })

  it('verify-otp should fail with incorrect code', async () => {
    const req = new Request('http://localhost/api/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ 
        phone: '+14155550123', 
        code: '999999', // Incorrect code
        criteria: { priceMax: 2000 }
      }),
      headers: { 'Content-Type': 'application/json' }
    })
    
    const res = await verifyOtp(req)
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error).toBe('Invalid OTP code')
  })
})
