import { ArrowRightIcon, AuthHeading, Button, IconTile, Input } from '@baren/ui'
import { useState, type FormEvent } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../app/routes'
import { ArrowLeftIcon, KeyIcon } from '../components/icons'
import { FormError } from '../components/FormError'
import { api } from '../lib/api'
import { useSendsEmail } from '../lib/providers'
import { useSession } from '../state/session'
import { authErrorFor, isValidEmail } from './errors'
import { AuthLayout } from './AuthLayout'
import css from './Auth.module.css'

/**
 * Artboard 22: ask for a password-reset code. The server answers the same way whether or not
 * the account exists, so this always moves on to the code step (23).
 */
export function ForgotScreen() {
  const [, navigate] = useLocation()
  const sendsEmail = useSendsEmail()
  const [email, setEmail] = useState(() => useSession.getState().emailHint)
  const [errors, setErrors] = useState<{ email?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const trimmed = email.trim()
    if (!isValidEmail(trimmed)) {
      setErrors({ email: 'Enter a valid email address.' })
      return
    }
    setErrors({})
    setBusy(true)
    try {
      await api.forgotPassword(trimmed)
      const session = useSession.getState()
      session.setEmailHint(trimmed)
      session.setPasswordReset({ email: trimmed, sentAt: Date.now() })
      navigate(paths.reset)
    } catch (error) {
      const { field, message } = authErrorFor(error)
      setErrors(field === 'email' ? { email: message } : { form: message })
      setBusy(false)
    }
  }

  const back = () => {
    useSession.getState().setEmailHint(email.trim())
    navigate(paths.signIn)
  }

  return (
    <AuthLayout>
      <form className={`${css.form} ${css.formStep}`} onSubmit={(e) => void submit(e)} noValidate>
        <IconTile>
          <KeyIcon size={22} />
        </IconTile>
        <AuthHeading
          className={css.leadCompact}
          title="Forgot your password?"
          lead={
            sendsEmail
              ? "Enter the email you signed up with and we'll send you a 6-digit code to reset it."
              : "Enter the email you signed up with. This server doesn't send email, so ask its admin for the 6-digit reset code."
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
            Send reset code
          </Button>
          <Button
            variant="link"
            className={css.back}
            leadingIcon={<ArrowLeftIcon size={14} />}
            onClick={back}
          >
            Back to sign in
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
