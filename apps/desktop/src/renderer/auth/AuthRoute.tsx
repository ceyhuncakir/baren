/** Lazily loaded chunk with every auth step and the invite landing screen. */
import type { AuthStep } from '../app/routes'
import { BrowserScreen } from './BrowserScreen'
import { ForgotScreen } from './ForgotScreen'
import { InviteScreen } from './InviteScreen'
import { RegisterScreen } from './RegisterScreen'
import { ResetScreen } from './ResetScreen'
import { SignInScreen } from './SignInScreen'
import { VerifyScreen } from './VerifyScreen'

export type AuthRouteProps = { step: AuthStep } | { invite: string }

export default function AuthRoute(props: AuthRouteProps) {
  if ('invite' in props) return <InviteScreen token={props.invite} />
  switch (props.step) {
    case 'sign-in':
      return <SignInScreen />
    case 'register':
      return <RegisterScreen />
    case 'verify':
      return <VerifyScreen />
    case 'browser':
      return <BrowserScreen />
    case 'forgot':
      return <ForgotScreen />
    case 'reset':
      return <ResetScreen />
  }
}
