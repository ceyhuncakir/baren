/**
 * Password strength for the create-account form (artboard 19: four bars + label).
 * Deliberately simple and deterministic; the server enforces the real policy.
 */

export type StrengthScore = 0 | 1 | 2 | 3 | 4

export const STRENGTH_LABELS: Record<StrengthScore, string> = {
  0: '',
  1: 'Weak',
  2: 'Fair',
  3: 'Good',
  4: 'Strong',
}

/** Minimum length shown in the hint "At least 8 characters, including a number." */
export const MIN_PASSWORD_LENGTH = 8

export function scorePassword(password: string): StrengthScore {
  if (password.length === 0) return 0
  if (password.length < MIN_PASSWORD_LENGTH || !/\d/.test(password)) return 1

  let classes = 0
  if (/[a-z]/.test(password)) classes++
  if (/[A-Z]/.test(password)) classes++
  if (/\d/.test(password)) classes++
  if (/[^A-Za-z0-9]/.test(password)) classes++

  // Repeated single characters ("aaaaaaa1") are weak regardless of length.
  if (/^(.)\1+\d*$/.test(password)) return 1

  let score = 2
  if (password.length >= 10 && classes >= 2) score = 3
  if (password.length >= 14 && classes >= 3) score = 4
  if (password.length >= 12 && classes === 4) score = 4
  return score as StrengthScore
}

/** Meets the minimum policy from the hint text. */
export function isAcceptablePassword(password: string): boolean {
  return scorePassword(password) >= 2
}
