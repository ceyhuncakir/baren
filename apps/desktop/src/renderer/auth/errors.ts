/** Maps server error codes to the field they belong to and a message (unit-tested). */
import { isApiError } from '@baren/sync-client/api'

export type AuthField = 'name' | 'email' | 'password' | 'code' | 'form'

export interface FieldError {
  field: AuthField
  message: string
}

const BY_CODE: Record<string, FieldError> = {
  invalid_credentials: { field: 'password', message: 'Wrong email or password.' },
  email_taken: { field: 'email', message: 'An account with this email already exists.' },
  invalid_email: { field: 'email', message: 'Enter a valid email address.' },
  weak_password: { field: 'password', message: 'Use at least 8 characters, including a number.' },
  invalid_name: { field: 'name', message: 'Enter your name.' },
  invalid_code: { field: 'code', message: "That code isn't right. Check the email and try again." },
  code_expired: { field: 'code', message: 'This code has expired. Send a new one.' },
  too_many_attempts: { field: 'code', message: 'Too many attempts. Send a new code.' },
  rate_limited: { field: 'form', message: 'Too many attempts. Wait a moment and try again.' },
  network_error: {
    field: 'form',
    message: "Can't reach the server. Check your connection, or continue offline.",
  },
}

export function authErrorFor(error: unknown): FieldError {
  if (isApiError(error)) {
    const known = BY_CODE[error.code]
    if (known) return known
    if (error.status === 0) return BY_CODE['network_error'] as FieldError
    return { field: 'form', message: error.message || 'Something went wrong. Try again.' }
  }
  return {
    field: 'form',
    message: error instanceof Error && error.message ? error.message : 'Something went wrong.',
  }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim())
}

/** "0:24" */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Seconds until another code may be requested (the server allows one per 30 s). */
export const RESEND_COOLDOWN_S = 30

export function resendRemaining(sentAt: number, now: number): number {
  const elapsed = Math.max(0, now - sentAt)
  return Math.max(0, RESEND_COOLDOWN_S - Math.floor(elapsed / 1000))
}
