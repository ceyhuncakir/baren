/**
 * Events that arrive from outside the page:
 *  - bridge.onDeepLink: baren://invite/<token> opens the invite landing screen, and
 *    baren://file/<id>[/<page id>][?node=<layer id>] opens that file (a local file, or a team
 *    file from "Copy link") at the page or layer;
 *  - `baren:command` DOM events from the macOS native menu (desktop-shell preload): command
 *    ids, plus `app.checkForUpdates` so a check started there gets the same feedback card.
 */
import { toast } from '@baren/ui'
import { useEffect } from 'react'
import { api } from '../lib/api'
import { bridge } from '../lib/bridge'
import { isCommandId, runCommand } from '../lib/commands'
import { parseDeepLink, type DeepLink } from '../lib/deepLink'
import { linkedLocalFile, localFileFor, requestReveal } from '../state/fileLinks'
import { useFiles } from '../state/files'
import { useSession } from '../state/session'
import { runAppAction } from './actions'
import { paths } from './routes'

/** The session once it is known (a cold-start link can arrive before the profile loads). */
function settledSession(timeoutMs = 10_000) {
  return new Promise<ReturnType<typeof useSession.getState>>((resolve) => {
    if (useSession.getState().status !== 'unknown') return resolve(useSession.getState())
    const done = () => {
      off()
      clearTimeout(timer)
      resolve(useSession.getState())
    }
    const off = useSession.subscribe((s) => {
      if (s.status !== 'unknown') done()
    })
    const timer = setTimeout(done, timeoutMs)
  })
}

/**
 * Open the file a file link names, at its layer or page. A file on this machine opens right
 * away, signed in or not; a team file it does not have yet needs a session to pull it.
 */
async function openFileLink(
  link: Extract<DeepLink, { kind: 'file' }>,
  navigate: (to: string) => void,
): Promise<void> {
  let fileId = await linkedLocalFile(link.fileId, bridge.files).catch(() => null)
  if (!fileId) {
    const session = await settledSession()
    if (session.status !== 'signedIn') {
      toast('Sign in to open this file.')
      if (session.status === 'signedOut') navigate(paths.signIn)
      return
    }
    fileId = await localFileFor(link.fileId, session.teams, { api, files: bridge.files }).catch(
      () => null,
    )
    if (!fileId) {
      toast("You don't have access to this file. Ask a teammate to invite you to its team.")
      return
    }
  }
  const target = link.node ?? link.pageId
  if (target) requestReveal(fileId, target)
  useFiles.getState().markOpened(fileId)
  // The editor route sends a file the list does not have back home: list it first.
  await useFiles.getState().load()
  navigate(paths.file(fileId))
}

export function useBridgeEvents(navigate: (to: string) => void): void {
  useEffect(() => {
    const offDeepLink = bridge.onDeepLink((url) => {
      const link = parseDeepLink(url)
      if (!link) return
      if (link.kind === 'file') {
        void openFileLink(link, navigate)
        return
      }
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
