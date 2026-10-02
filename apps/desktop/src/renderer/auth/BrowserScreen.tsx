import type { DeviceStartResponse } from '@baren/sync-client/api'
import {
  ArrowUpRightIcon,
  AuthHeading,
  BrowserOpenIcon,
  Button,
  CopyIcon,
  IconTile,
  Spinner,
  toast,
} from '@baren/ui'
import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../app/routes'
import { FormError } from '../components/FormError'
import { api, errorMessage, isTransientApiError } from '../lib/api'
import { bridge } from '../lib/bridge'
import { copyText } from '../lib/clipboard'
import { DeviceFlowError, pollDevice } from '../lib/devicePoll'
import { useFinishSignIn } from './common'
import { AuthLayout } from './AuthLayout'
import css from './Auth.module.css'

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; start: DeviceStartResponse }
  | { kind: 'failed'; message: string }

/**
 * Artboard 21, the device-code flow: start a request, open the approval page in the
 * default browser, show the code to compare, and poll until approved. The page the server
 * shows after approval links back with baren://auth/<code>, which wakes the poller.
 */
export function BrowserScreen() {
  const [, navigate] = useLocation()
  const finish = useFinishSignIn()
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })

  useEffect(() => {
    const controller = new AbortController()
    setPhase({ kind: 'starting' })
    void (async () => {
      try {
        const start = await api.auth.deviceStart()
        if (controller.signal.aborted) return
        setPhase({ kind: 'waiting', start })
        void bridge.shell.openExternal(start.verifyUrl)
        const auth = await pollDevice(start, {
          poll: (code) => api.auth.devicePoll(code),
          signal: controller.signal,
          isTransient: isTransientApiError,
        })
        await finish(auth)
      } catch (error) {
        if (controller.signal.aborted) return
        const message =
          error instanceof DeviceFlowError
            ? error.reason === 'denied'
              ? 'Sign-in was denied in the browser.'
              : 'The sign-in request expired.'
            : errorMessage(error)
        setPhase({ kind: 'failed', message })
      }
    })()
    return () => controller.abort()
  }, [attempt, finish])

  const start = phase.kind === 'waiting' ? phase.start : null

  const copy = useCallback(async (text: string, what: string) => {
    toast((await copyText(text)) ? `${what} copied` : `Couldn't copy the ${what.toLowerCase()}`)
  }, [])

  return (
    <AuthLayout>
      <div className={`${css.form} ${css.formStep}`}>
        <IconTile>
          <BrowserOpenIcon size={22} />
        </IconTile>
        <AuthHeading
          title="Continue in your browser"
          lead="We opened a sign-in page in your default browser. Finish there and this window will update on its own."
        />
        <div className={css.codeBox}>
          <div className={css.codeLabel}>Make sure the browser shows this code</div>
          <div className={css.row}>
            <div className={css.code} aria-live="polite">
              {start?.userCode ?? '———————'}
            </div>
            <Button
              variant="outline"
              size={28}
              leadingIcon={<CopyIcon size={12} />}
              disabled={!start}
              onClick={() => start && void copy(start.userCode, 'Code')}
            >
              Copy
            </Button>
          </div>
        </div>
        {phase.kind === 'failed' ? (
          <FormError>{phase.message}</FormError>
        ) : (
          <div className={css.waiting} role="status">
            <Spinner size={16} />
            {phase.kind === 'starting' ? 'Starting sign-in…' : 'Waiting for you to sign in…'}
          </div>
        )}
        <div className={css.actions}>
          {phase.kind === 'failed' ? (
            <Button size={40} fullWidth onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          ) : (
            <Button
              variant="raised"
              size={40}
              fullWidth
              className={css.gap8}
              disabled={!start}
              trailingIcon={<ArrowUpRightIcon size={13} />}
              onClick={() => start && void bridge.shell.openExternal(start.verifyUrl)}
            >
              Open browser again
            </Button>
          )}
          <div className={css.row}>
            <Button
              variant="link-muted"
              disabled={!start}
              onClick={() => start && void copy(start.verifyUrl, 'Sign-in link')}
            >
              Copy sign-in link
            </Button>
            <Button variant="link" onClick={() => navigate(paths.signIn)}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </AuthLayout>
  )
}
