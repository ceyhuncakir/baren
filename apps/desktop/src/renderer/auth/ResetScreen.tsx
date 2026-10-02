import {
  ArrowRightIcon,
  AuthHeading,
  Button,
  Callout,
  CodeInput,
  Field,
  IconTile,
  Input,
  isAcceptablePassword,
  PasswordStrength,
  toast,
} from '@baren/ui'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Redirect, useLocation } from 'wouter'
import { paths } from '../app/routes'
import { LockKeyholeIcon } from '../components/icons'
import { FormError } from '../components/FormError'
import { DESIGN_USER } from '../fixtures/design'
import { api, errorMessage } from '../lib/api'
import { isDesignFixture } from '../lib/fixture'
import { useSendsEmail } from '../lib/providers'
import { useSession, type PendingVerification } from '../state/session'
import { useFinishSignIn, useResendCountdown } from './common'
import { authErrorFor, formatCountdown } from './errors'
import { AuthLayout } from './AuthLayout'
import css from './Auth.module.css'

const CODE_LENGTH = 6

type Errors = { code?: string; password?: string; form?: string }

function ResetForm({ reset }: { reset: PendingVerification }) {
  const [, navigate] = useLocation()
  const finish = useFinishSignIn()
  const sendsEmail = useSendsEmail()
  const codeId = useId()
  const passwordId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const remaining = useResendCountdown(reset.sentAt)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const next: Errors = {}
    if (code.length !== CODE_LENGTH) next.code = `Enter the ${CODE_LENGTH}-digit code.`
    if (!isAcceptablePassword(password))
      next.password = 'Use at least 8 characters, including a number.'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setBusy(true)
    try {
      await finish(await api.resetPassword(reset.email, code, password))
      toast('Password changed. Other devices were signed out.')
    } catch (error) {
      const { field, message } = authErrorFor(error)
      setErrors(field === 'code' || field === 'password' ? { [field]: message } : { form: message })
      setBusy(false)
    }
  }

  const resend = async () => {
    try {
      await api.forgotPassword(reset.email)
      useSession.getState().setPasswordReset({ ...reset, sentAt: Date.now() })
      setCode('')
      setErrors({})
      toast(
        sendsEmail
          ? `We sent a new code to ${reset.email}`
          : 'A new code was issued. Ask the server admin for it.',
      )
    } catch (e) {
      toast(errorMessage(e))
    }
  }

  const back = () => {
    useSession.getState().setEmailHint(reset.email)
    navigate(paths.signIn)
  }

  return (
    <form className={`${css.form} ${css.formStep}`} onSubmit={(e) => void submit(e)} noValidate>
      <IconTile>
        <LockKeyholeIcon size={22} />
      </IconTile>
      <AuthHeading
        title="Set a new password"
        lead={
          sendsEmail
            ? `We sent a ${CODE_LENGTH}-digit code to ${reset.email}. Enter it below with your new password.`
            : `Ask the server admin for the ${CODE_LENGTH}-digit code for ${reset.email}, then choose a new password.`
        }
      />
      <div className={`${css.fields} ${css.fieldsReset}`}>
        <Field label="Reset code" htmlFor={codeId} error={errors.code}>
          <CodeInput
            id={codeId}
            value={code}
            length={CODE_LENGTH}
            autoFocus
            invalid={errors.code !== undefined}
            disabled={busy}
            onChange={(next) => {
              setCode(next)
              if (errors.code) setErrors((prev) => ({ ...prev, code: undefined }))
            }}
            // Auto-advance: a complete code moves on to the new password.
            onComplete={() => passwordRef.current?.focus()}
          />
        </Field>
        <Field label="New password" htmlFor={passwordId} error={errors.password}>
          <Input
            ref={passwordRef}
            id={passwordId}
            name="new-password"
            autoComplete="new-password"
            revealable
            value={password}
            error={errors.password !== undefined}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <PasswordStrength password={password} />
          {errors.password === undefined && (
            <div className={css.hint}>At least 8 characters, including a number.</div>
          )}
        </Field>
      </div>
      <div className={css.actions}>
        <FormError>{errors.form}</FormError>
        <Button
          type="submit"
          size={40}
          fullWidth
          loading={busy}
          trailingIcon={<ArrowRightIcon size={14} />}
        >
          Reset password
        </Button>
        <div className={css.row}>
          <span className={css.inline}>
            <span className={css.muted}>Didn't get a code?</span>
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
          <Button variant="link" onClick={back}>
            Back to sign in
          </Button>
        </div>
      </div>
      <Callout>Resetting your password signs you out of Baren on your other devices.</Callout>
    </form>
  )
}

/** Artboard 23: the emailed code + a new password; success signs in. */
export function ResetScreen() {
  const pending = useSession((s) => s.passwordReset)
  // Fixture mode can open this step directly with the design's account.
  const fixture = useMemo<PendingVerification | null>(
    () => (isDesignFixture ? { email: DESIGN_USER.email, sentAt: Date.now() - 6_000 } : null),
    [],
  )
  const reset = pending ?? fixture
  if (!reset) return <Redirect to={paths.forgot} replace />
  return (
    <AuthLayout>
      <ResetForm key={reset.email} reset={reset} />
    </AuthLayout>
  )
}
