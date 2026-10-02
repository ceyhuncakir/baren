import { AuthHeading, Button, Callout, CodeInput, IconTile, MailIcon, toast } from '@baren/ui'
import { useMemo, useState, type FormEvent } from 'react'
import { Redirect, useLocation } from 'wouter'
import { paths } from '../app/routes'
import { FormError } from '../components/FormError'
import { DESIGN_SIGNUP } from '../fixtures/design'
import { api, errorMessage } from '../lib/api'
import { isDesignFixture } from '../lib/fixture'
import { useSendsEmail } from '../lib/providers'
import { useSession, type PendingVerification } from '../state/session'
import { useFinishSignIn, useResendCountdown } from './common'
import { authErrorFor, formatCountdown } from './errors'
import { AuthLayout } from './AuthLayout'
import css from './Auth.module.css'

const CODE_LENGTH = 6

function VerifyForm({ verification }: { verification: PendingVerification }) {
  const [, navigate] = useLocation()
  const finish = useFinishSignIn()
  const sendsEmail = useSendsEmail()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const remaining = useResendCountdown(verification.sentAt)

  const verify = async (value: string) => {
    if (busy || value.length !== CODE_LENGTH) return
    setBusy(true)
    setError(null)
    try {
      await finish(await api.auth.verify(verification.email, value))
    } catch (e) {
      setError(authErrorFor(e).message)
      setBusy(false)
    }
  }

  const resend = async () => {
    try {
      await api.auth.resendCode(verification.email)
      useSession.getState().setVerification({ ...verification, sentAt: Date.now() })
      setCode('')
      setError(null)
      toast(
        sendsEmail
          ? `We sent a new code to ${verification.email}`
          : 'A new code was issued. Ask the server admin for it.',
      )
    } catch (e) {
      toast(errorMessage(e))
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void verify(code)
  }

  return (
    <form className={`${css.form} ${css.formStep}`} onSubmit={onSubmit} noValidate>
      <IconTile>
        <MailIcon size={22} strokeWidth={1.6} />
      </IconTile>
      <AuthHeading
        title={sendsEmail ? 'Check your email' : 'Enter your code'}
        lead={
          sendsEmail
            ? `We sent a ${CODE_LENGTH}-digit code to ${verification.email}. It expires in 10 minutes.`
            : `Ask the server admin for the ${CODE_LENGTH}-digit code for ${verification.email}. It expires in 10 minutes.`
        }
      />
      <CodeInput
        value={code}
        length={CODE_LENGTH}
        autoFocus
        aria-label="Verification code"
        invalid={error !== null}
        disabled={busy}
        onChange={(next) => {
          setCode(next)
          if (error) setError(null)
        }}
        onComplete={(value) => void verify(value)}
      />
      <div className={css.actions}>
        <FormError>{error}</FormError>
        <Button
          type="submit"
          size={40}
          fullWidth
          loading={busy}
          disabled={code.length !== CODE_LENGTH}
        >
          Verify email
        </Button>
        <div className={css.row}>
          <span className={css.inline}>
            <span className={css.muted}>Didn't get it?</span>
            {remaining > 0 ? (
              <span className={css.subtle} aria-live="polite">
                Resend in {formatCountdown(remaining)}
              </span>
            ) : (
              <Button variant="link" onClick={() => void resend()}>
                Resend code
              </Button>
            )}
          </span>
          <Button variant="link" onClick={() => navigate(paths.register)}>
            Change email
          </Button>
        </div>
      </div>
      <Callout>
        {sendsEmail
          ? "Can't find it? Check your spam folder. The email comes from Baren."
          : "This server doesn't send email. Its admin can find your code in the server log."}
      </Callout>
    </form>
  )
}

/** Artboard 20. Reached after registering, or when signing in to an unverified account. */
export function VerifyScreen() {
  const pending = useSession((s) => s.verification)
  // Fixture mode can open this step directly with the design's sign-up.
  const fixture = useMemo<PendingVerification | null>(
    () =>
      isDesignFixture
        ? { email: DESIGN_SIGNUP.email, sentAt: Date.now() - DESIGN_SIGNUP.codeSentAgo }
        : null,
    [],
  )
  const verification = pending ?? fixture
  if (!verification) return <Redirect to={paths.register} replace />
  return (
    <AuthLayout>
      <VerifyForm key={verification.email} verification={verification} />
    </AuthLayout>
  )
}
