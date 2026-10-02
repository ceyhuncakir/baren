import { Toaster } from '@baren/ui'
import { useEffect, useMemo } from 'react'
import { Redirect, Router, useLocation } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'
import { HomeLayout } from '../home/HomeLayout'
import { FilesScreen } from '../home/FilesScreen'
import { bridge, isMockBridge } from '../lib/bridge'
import { useWindowTitleOverride } from '../lib/windowTitle'
import { useFiles } from '../state/files'
import { useSession } from '../state/session'
import { registerHelpCommands } from './actions'
import { AppDialogs } from './AppDialogs'
import { AppTitleBar } from './AppTitleBar'
import { EditorRoute } from './EditorRoute'
import { rememberLocation } from './lastRoute'
import { AuthScreens, TeamScreens, warmScreens } from './screens'
import { UpdateToast } from './UpdateToast'
import { paths, requiresSession, resolveRoute, titleForRoute, type AppRoute } from './routes'
import { useBridgeEvents } from './useBridgeEvents'
import { useGlobalKeys } from './useGlobalKeys'
import css from './App.module.css'

const AuthRoute = AuthScreens.Component
const TeamScreen = TeamScreens.Component

// Without a cached session the first screen is sign-in: fetch it alongside the entry chunk.
if (useSession.getState().status !== 'signedIn') void AuthScreens.preload().catch(() => undefined)

function RouteView({ route }: { route: AppRoute }) {
  switch (route.kind) {
    case 'home':
      return (
        <HomeLayout active={route.view}>
          <FilesScreen key={route.view} view={route.view} />
        </HomeLayout>
      )
    case 'team':
      return (
        <HomeLayout active="settings">
          <TeamScreen tab={route.tab} />
        </HomeLayout>
      )
    case 'auth':
      return <AuthRoute step={route.step} />
    case 'invite':
      return <AuthRoute invite={route.token} />
    case 'file':
      return <EditorRoute fileId={route.fileId} />
    case 'notFound':
      return <Redirect to={paths.recents} replace />
  }
}

function useFileName(route: AppRoute): string | null {
  const fileId = route.kind === 'file' ? route.fileId : null
  return useFiles((s) => (fileId ? (s.files.find((f) => f.id === fileId)?.name ?? null) : null))
}

/** Diagnostics node: platform and bridge kind (read by the foundation smoke test). */
function AppInfo() {
  return (
    <div data-testid="app-placeholder" hidden>
      Baren · {bridge.platform} · {isMockBridge ? 'mock bridge' : 'desktop bridge'}
    </div>
  )
}

function Shell() {
  const [location, navigate] = useLocation()
  const route = useMemo(() => resolveRoute(location), [location])
  const status = useSession((s) => s.status)
  const fileName = useFileName(route)
  const titleOverride = useWindowTitleOverride()
  const title = titleOverride ?? titleForRoute(route, fileName)

  useGlobalKeys()
  useBridgeEvents(navigate)

  useEffect(() => {
    void useSession.getState().bootstrap()
    warmScreens()
    return registerHelpCommands()
  }, [])

  useEffect(() => rememberLocation(location), [location])

  useEffect(() => {
    document.title = title === 'Baren' ? title : `${title} — Baren`
  }, [title])

  let body
  if (requiresSession(route) && status === 'unknown') body = null
  else if (requiresSession(route) && status === 'signedOut')
    body = <Redirect to={paths.signIn} replace />
  else body = <RouteView route={route} />

  return (
    <div className={css.app}>
      <AppTitleBar title={title} />
      <main className={css.body}>{body}</main>
      <AppDialogs />
      <UpdateToast />
      <Toaster />
      <AppInfo />
    </div>
  )
}

/** Root: hash routing (the app:// scheme serves files, so routes live after '#'). */
export function App() {
  return (
    <Router hook={useHashLocation}>
      <Shell />
    </Router>
  )
}
