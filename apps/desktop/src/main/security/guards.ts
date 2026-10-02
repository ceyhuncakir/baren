import type { Session, WebContents } from 'electron'
import type { Logger } from '../log'
import { isAppUrl, isSafeExternalUrl } from './urls'

/** Permissions the renderer may use; everything else (camera, geolocation, …) is denied. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
])

export function isPermissionAllowed(
  permission: string,
  requestingUrl: string,
  appOrigins: readonly string[],
): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl, appOrigins)
}

export function installPermissionHandlers(session: Session, appOrigins: readonly string[]): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      isPermissionAllowed(permission, details.requestingUrl || webContents.getURL(), appOrigins),
    )
  })
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, appOrigins),
  )
}

/**
 * Lock a window's contents to the app: no navigation away, no popups, no
 * <webview>. Web links open in the system browser instead.
 */
export function guardWebContents(
  contents: WebContents,
  appOrigins: readonly string[],
  openExternal: (url: string) => void,
  log: Logger,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) openExternal(url)
    else log.warn('blocked window.open', { url })
    return { action: 'deny' }
  })

  const blockForeignNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url, appOrigins)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) openExternal(url)
    else log.warn('blocked navigation', { url })
  }
  contents.on('will-navigate', (event) => blockForeignNavigation(event, event.url))
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) blockForeignNavigation(event, event.url)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}
