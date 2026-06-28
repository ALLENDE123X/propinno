import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET as testPipeline } from '@/app/api/admin/test-pipeline/route'
import { GET as statusPipeline } from '@/app/api/admin/status/route'

vi.mock('@/lib/twilio', () => ({
  sendSMS: vi.fn().mockResolvedValue('mock-sms-sid'),
  sendAdminAlert: vi.fn().mockResolvedValue('mock-alert-sid')
}))

vi.mock('@/inngest/functions/matchingEngine', () => ({
  findMatchingUsers: vi.fn().mockResolvedValue([{ user_id: 'test-user-id' }])
}))

vi.mock('@/lib/db', () => ({
  db: {
    delete: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockImplementation((val) => {
      return {
        returning: vi.fn().mockResolvedValue([{ id: val.phone ? 'test-user-id' : 'test-listing-id' }])
      }
    }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockResolvedValue([{ source: 'test', count: 5, lastPoll: new Date() }])
  }
}))

describe('Admin APIs', () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = 'test-secret'
    vi.clearAllMocks()
  })

  describe('/api/admin/test-pipeline', () => {
    it('returns 401 with missing secret', async () => {
      const req = new Request('http://localhost/api/admin/test-pipeline')
      const res = await testPipeline(req)
      expect(res.status).toBe(401)
    })

    it('returns 401 with wrong secret', async () => {
      const req = new Request('http://localhost/api/admin/test-pipeline?secret=wrong')
      const res = await testPipeline(req)
      expect(res.status).toBe(401)
    })

    it('succeeds with correct secret', async () => {
      const req = new Request('http://localhost/api/admin/test-pipeline?secret=test-secret')
      const res = await testPipeline(req)
      const data = await res.json()
      
      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.smsSid).toBe('mock-sms-sid')
    })
  })

  describe('/api/admin/status', () => {
    it('returns 401 with missing secret', async () => {
      const req = new Request('http://localhost/api/admin/status')
      const res = await statusPipeline(req)
      expect(res.status).toBe(401)
    })

    it('succeeds with correct secret', async () => {
      const req = new Request('http://localhost/api/admin/status?secret=test-secret')
      // For status, we mock where to return the single row with count
      const dbModule = await import('@/lib/db')
      const db = dbModule.db as unknown as { where: any, from: any }
      db.where = vi.fn().mockResolvedValue([{ count: 10 }])
      db.from = vi.fn().mockImplementation(() => {
        const chain = {
          where: vi.fn().mockResolvedValue([{ count: 10 }]),
          groupBy: vi.fn().mockResolvedValue([{ source: 'test', count: 5, lastPoll: new Date() }])
        }
        // If it's a plain from without where (like totalSent)
        // Drizzle allows awaiting from directly, so it should act as a promise
        return Object.assign(Promise.resolve([{ count: 10 }]), chain)
      })

      const res = await statusPipeline(req)
      const data = await res.json()
      
      expect(res.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.activeUsers).toBe(10)
    })
  })
})
