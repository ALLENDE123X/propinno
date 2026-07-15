import twilio from 'twilio'
import { logger } from './logger'

const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const apiKeySid = process.env.TWILIO_API_KEY_SID
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET
const fromNumber = process.env.TWILIO_FROM

/**
 * Build a Twilio REST client.
 *
 * Auth precedence:
 *  1. API Key (SK... SID + secret) scoped to the account — Twilio's recommended
 *     auth method. Used when TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET are set.
 *  2. Legacy Account SID + Auth Token, as a fallback.
 *
 * Returns null if neither a usable API key pair nor an auth token is configured,
 * which callers treat as "dev mode / skip real send".
 */
export function createTwilioClient() {
  if (!accountSid) return null

  if (apiKeySid && apiKeySecret) {
    return twilio(apiKeySid, apiKeySecret, { accountSid })
  }

  if (authToken) {
    return twilio(accountSid, authToken)
  }

  return null
}

export const twilioClient = createTwilioClient()

export async function sendSMS(to: string, body: string) {
  if (!twilioClient) {
    logger.warn('Twilio credentials missing (need TWILIO_ACCOUNT_SID + either an API key pair or TWILIO_AUTH_TOKEN), skipping actual SMS send (development mode)')
    logger.info(`[SMS to ${to}]`)
    return 'mock-sid'
  }

  if (!fromNumber) {
    logger.error('TWILIO_FROM is missing, cannot send SMS')
    throw new Error('TWILIO_FROM is missing')
  }

  const message = await twilioClient.messages.create({
    body,
    from: fromNumber,
    to,
  })

  logger.info(`Sent SMS to ${to}: ${message.sid}`)
  return message.sid
}

export async function sendAdminAlert(body: string) {
  const adminPhone = process.env.ADMIN_PHONE || '+14044446018'
  return sendSMS(adminPhone, `[PROPINNO ALERT] ${body}`)
}
