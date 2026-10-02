import { ApiError } from '@baren/sync-client/api'
import { describe, expect, it } from 'vitest'
import { authErrorFor, formatCountdown, isValidEmail, resendRemaining } from './errors'

describe('auth errors', () => {
  it('routes server codes to fields', () => {
    expect(authErrorFor(new ApiError(401, 'invalid_credentials', 'x'))).toMatchObject({
      field: 'password',
    })
    expect(authErrorFor(new ApiError(409, 'email_taken', 'x'))).toMatchObject({ field: 'email' })
    expect(authErrorFor(new ApiError(400, 'invalid_code', 'x'))).toMatchObject({ field: 'code' })
    expect(authErrorFor(new ApiError(0, 'aborted', 'x'))).toMatchObject({ field: 'form' })
    expect(authErrorFor(new ApiError(0, 'network_error', 'x')).message).toMatch(/offline/)
    expect(authErrorFor(new ApiError(500, 'internal', 'Server broke'))).toEqual({
      field: 'form',
      message: 'Server broke',
    })
    expect(authErrorFor('weird')).toMatchObject({ field: 'form' })
  })

  it('formats the resend countdown of artboard 20', () => {
    expect(resendRemaining(0, 6_000)).toBe(24)
    expect(formatCountdown(24)).toBe('0:24')
    expect(resendRemaining(0, 31_000)).toBe(0)
    expect(resendRemaining(10_000, 0)).toBe(30)
    expect(formatCountdown(75)).toBe('1:15')
  })

  it('validates emails loosely', () => {
    expect(isValidEmail(' defne@example.com ')).toBe(true)
    expect(isValidEmail('defne@baren')).toBe(false)
  })
})
