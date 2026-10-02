import { isApiError } from '@baren/sync-client/api'
import { ArrowRightIcon, AuthHeading, Button, Input } from '@baren/ui'
import { useEffect, useState, type FormEvent } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../app/routes'
import { FormError } from '../components/FormError'
import { api } from '../lib/api'
import { signalAppReady } from '../lib/ready'
import { useSession } from '../state/session'
import { AlternativeLinks, useFinishSignIn } from './common'
import { authErrorFor, isValidEmail, type AuthField } from './errors'
import { AuthLayout } from './AuthLayout'
import css from './Auth.module.css'

type Errors = Partial<Record<AuthField, string>>

/** Artboard 18: email + password (there is no social sign-in). */
export function SignInScreen() {
  const [, navigate] = useLocation()
  const finish = useFinishSignIn()
  const [email, setEmail] = useState(() => useSession.getState().emailHint)
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const invite = useSession((s) => s.pendingInvite)

  useEffect(() => signalAppReady(), [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const next: Errors = {}
    if (!isValidEmail(email)) next.email = 'Enter a valid email address.'
    if (!password) next.password = 'Enter your password.'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setBusy(true)
    try {
      await finish(await api.auth.login(email.trim(), password))
    } catch (error) {
      if (isApiError(error) && error.code === 'email_not_verified') {
        useSession.getState().setVerification({ email: email.trim(), sentAt: Date.now() })
        void api.auth.resendCode(email.trim()).catch(() => undefined)
        navigate(paths.verify)
        return
      }
      const { field, message } = authErrorFor(error)
      setErrors({ [field]: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout footer={<AlternativeLinks browser />}>
      <form className={css.form} onSubmit={(e) => void submit(e)} noValidate>
        <AuthHeading
          className={css.leadCompact}
          title="Welcome back"
          lead={
            invite
              ? 'Sign in to accept your team invite.'
              : 'Sign in to pick up where you left off.'
          }
        />
        <div className={css.fields}>
          <Input
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            autoFocus
            value={email}
            error={errors.email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <Input
            label="Password"
            labelAction={
              <Button
                variant="link-muted"
                textSize={12}
                onClick={() => {
                  useSession.getState().setEmailHint(email.trim())
                  navigate(paths.forgot)
                }}
              >
                Forgot password?
              </Button>
            }
            name="password"
            autoComplete="current-password"
            placeholder="Enter your password"
            revealable
            value={password}
            error={errors.password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
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
            Sign in
          </Button>
          <div className={css.switch}>
            New to Baren?
            <Button variant="link" onClick={() => navigate(paths.register)}>
              Create an account
            </Button>
          </div>
        </div>
      </form>
    </AuthLayout>
  )
}
