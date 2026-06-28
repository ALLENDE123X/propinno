import { describe, it, expect, vi, beforeEach } from 'vitest'
import { failureAlert } from '@/inngest/functions/failureAlert'
import { sendAdminAlert } from '@/lib/twilio'
import * as Sentry from '@sentry/nextjs'

vi.mock('@/lib/twilio', () => ({
  sendAdminAlert: vi.fn().mockResolvedValue('mock-sid'),
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}))

describe('failureAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends admin alert and captures exception in Sentry', async () => {
    const mockEvent = {
      data: {
        function_id: 'test-function',
        error: {
          message: 'Test error message',
          stack: 'Test stack trace',
        },
      },
    }

    const mockStep = {
      run: vi.fn().mockImplementation((name, fn) => fn()),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (failureAlert as any).fn({ event: mockEvent, step: mockStep })

    expect(mockStep.run).toHaveBeenCalledWith('log-and-alert-failure', expect.any(Function))
    expect(Sentry.captureException).toHaveBeenCalledWith(new Error('Inngest function test-function failed: Test error message'))
    expect(sendAdminAlert).toHaveBeenCalledWith('Inngest function failed: test-function. Error: Test error message')
  })
})
