import type { AuthResponse } from '@baren/sync-client/api'
import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { initialLocation } from '../app/lastRoute'
import { paths } from '../app/routes'
import { useSession } from '../state/session'
import { resendRemaining } from './errors'
import css from './Auth.module.css'

/** Seconds left before "Resend" is allowed (verify, reset), ticking once a second. */
export function useResendCountdown(sentAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  const counting = resendRemaining(sentAt, now) > 0
  useEffect(() => {
    setNow(Date.now())
    if (!counting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [counting, sentAt])
  return resendRemaining(sentAt, now)
}

/**
 * After any successful sign-in: store the session, then go to a pending invite, or back to the
 * last app screen (Recents on a first sign-in).
 */
export function useFinishSignIn(): (auth: AuthResponse) => Promise<void> {
  const [, navigate] = useLocation()
  return useCallback(
    async (auth: AuthResponse) => {
      await useSession.getState().completeSignIn(auth)
      const invite = useSession.getState().pendingInvite
      navigate(invite ? paths.invite(invite) : initialLocation(), { replace: true })
    },
    [navigate],
  )
}

/** "Continue offline" in the legal row. */
export function ContinueOffline() {
  const [, navigate] = useLocation()
  return (
    <span className={css.footerLinks}>
      <button
        type="button"
        className={css.footerLink}
        onClick={() => {
          useSession.getState().continueOffline()
          navigate(paths.recents, { replace: true })
        }}
      >
        Continue offline
      </button>
    </span>
  )
}
