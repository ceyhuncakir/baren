/**
 * Events that arrive from outside the page:
 *  - bridge.onDeepLink: baren://invite/<token> opens the invite landing screen;
 *  - `baren:command` DOM events from the macOS native menu (desktop-shell preload): command
 *    ids, plus `app.checkForUpdates` so a check started there gets the same feedback card.
 */
import { useEffect } from 'react'
import { bridge } from '../lib/bridge'
import { isCommandId, runCommand } from '../lib/commands'
import { parseDeepLink } from '../lib/deepLink'
import { useSession } from '../state/session'
import { runAppAction } from './actions'
import { paths } from './routes'

export function useBridgeEvents(navigate: (to: string) => void): void {
  useEffect(() => {
    const offDeepLink = bridge.onDeepLink((url) => {
      const link = parseDeepLink(url)
      if (!link) return
      useSession.getState().setPendingInvite(link.token)
      navigate(paths.invite(link.token))
    })

    const onCommand = (e: Event) => {
      const id = e instanceof CustomEvent ? (e.detail as unknown) : null
      if (isCommandId(id)) runCommand(id)
      else if (id === 'app.checkForUpdates') runAppAction(id)
    }
    window.addEventListener('baren:command', onCommand)

    return () => {
      offDeepLink()
      window.removeEventListener('baren:command', onCommand)
    }
  }, [navigate])
}
