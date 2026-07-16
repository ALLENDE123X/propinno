/**
 * Normalize a user-entered phone number to E.164 format (e.g. +14155550123),
 * which is required by Twilio's Verify and Messaging APIs (error 60200 is
 * thrown for non-E.164 `To` values like "4155550123").
 *
 * Rules (US-focused, since Propinno is SF-only):
 *  - Strips all non-digit characters except a leading "+".
 *  - If already prefixed with "+", it's assumed to be E.164 and returned
 *    with only the internal non-digits stripped.
 *  - A bare 10-digit number is treated as US and gets "+1" prepended.
 *  - An 11-digit number starting with "1" gets a "+" prepended.
 *  - Anything else is returned "+"-prefixed as a best effort; callers should
 *    still expect Twilio to validate.
 */
export function normalizePhoneE164(raw: string): string {
  const trimmed = raw.trim()
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')

  if (hasPlus) {
    return `+${digits}`
  }
  if (digits.length === 10) {
    return `+1${digits}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`
  }
  // Fallback: prefix with + and let Twilio validate.
  return `+${digits}`
}
