import {
  ArrowRightIcon,
  AuthHeading,
  Button,
  Field,
  Input,
  isAcceptablePassword,
  PasswordStrength,
} from '@baren/ui'
import { useId, useState, type FormEvent } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../app/routes'
import { FormError } from '../components/FormError'
import { api } from '../lib/api'
import { useSession } from '../state/session'
import { ContinueOffline } from './common'
import { authErrorFor, isValidEmail, type AuthField } from './errors'
import { AuthLayout } from './AuthLayout'
import css from './Auth.module.css'

type Errors = Partial<Record<AuthField, string>>

/** Artboard 19. Registration sends a 6-digit code; the verify step finishes sign-up. */
export function RegisterScreen() {
  const [, navigate] = useLocation()
  const passwordId = useId()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const next: Errors = {}
    if (!name.trim()) next.name = 'Enter your name.'
    if (!isValidEmail(email)) next.email = 'Enter a valid email address.'
    if (!isAcceptablePassword(password))
      next.password = 'Use at least 8 characters, including a number.'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setBusy(true)
    try {
      await api.auth.register({ name: name.trim(), email: email.trim(), password })
      useSession.getState().setVerification({ email: email.trim(), sentAt: Date.now() })
      navigate(paths.verify)
    } catch (error) {
      const { field, message } = authErrorFor(error)
      setErrors({ [field === 'code' ? 'form' : field]: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout footer={<ContinueOffline />}>
      <form className={`${css.form} ${css.formTight}`} onSubmit={(e) => void submit(e)} noValidate>
        <AuthHeading
          className={css.leadCompact}
          title="Create your account"
          lead="Set up your workspace in under a minute."
        />
        <div className={`${css.fields} ${css.fieldsTight}`}>
          <Input
            label="Full name"
            name="name"
            autoComplete="name"
            autoFocus
            value={name}
            error={errors.name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Input
            label="Work email"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            error={errors.email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <Field label="Password" htmlFor={passwordId} error={errors.password}>
            <Input
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
            Create account
          </Button>
          <div className={css.switch}>
            Already have an account?
            <Button variant="link" onClick={() => navigate(paths.signIn)}>
              Sign in
            </Button>
          </div>
        </div>
      </form>
    </AuthLayout>
  )
}
