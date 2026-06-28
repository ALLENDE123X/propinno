import twilio from 'twilio'
import { logger } from './logger'

const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const fromNumber = process.env.TWILIO_FROM

export const twilioClient = accountSid && authToken ? twilio(accountSid, authToken) : null

export async function sendSMS(to: string, body: string) {
  if (!twilioClient) {
    logger.warn('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing, skipping actual SMS send (development mode)')
    logger.info(`[SMS to ${to}]: ${body}`)
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
  // Use a hardcoded admin phone or ideally from env.
  // The ticket says "+14044446018" is the test user phone, I'll send alerts to the same or just expect ADMIN_PHONE.
  // Let's use process.env.ADMIN_PHONE or default to '+14044446018'.
  const adminPhone = process.env.ADMIN_PHONE || '+14044446018'
  return sendSMS(adminPhone, `[PROPINNO ALERT] ${body}`)
}
