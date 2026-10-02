import { StrictMode, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/styles/index.css'
import './playground.css'
import { NavItem, Toaster } from '../src'
import { DisplayPage } from './pages/DisplayPage'
import { EditorPage } from './pages/EditorPage'
import { FormsPage } from './pages/FormsPage'
import { IconsPage } from './pages/IconsPage'
import { ShellPage } from './pages/ShellPage'
import { Screen01Home } from './screens/Screen01Home'
import { Screen06Editor } from './screens/Screen06Editor'
import { Screen09Menu } from './screens/Screen09Menu'
import { ScreenFrame } from './screens/ScreenFrame'
import ref01 from '../../../design/reference/01-home-recents.png'
import ref06 from '../../../design/reference/06-editor-selection-inspector.png'
import ref09 from '../../../design/reference/09-menu-file.png'

interface Route {
  path: string
  label: string
  group: 'Components' | 'Screens'
  render: () => ReactNode
  /** Screens render without playground chrome at 1440×900. */
  screen?: { reference: string }
}

export const ROUTES: Route[] = [
  { path: 'shell', label: 'Shell', group: 'Components', render: () => <ShellPage /> },
  { path: 'forms', label: 'Forms', group: 'Components', render: () => <FormsPage /> },
  { path: 'display', label: 'Display', group: 'Components', render: () => <DisplayPage /> },
  { path: 'editor', label: 'Editor', group: 'Components', render: () => <EditorPage /> },
  { path: 'icons', label: 'Icons', group: 'Components', render: () => <IconsPage /> },
  {
    path: 'screen-01',
    label: '01 Home — Recents',
    group: 'Screens',
    render: () => <Screen01Home />,
    screen: { reference: ref01 },
  },
  {
    path: 'screen-06',
    label: '06 Editor — Selection',
    group: 'Screens',
    render: () => <Screen06Editor />,
    screen: { reference: ref06 },
  },
  {
    path: 'screen-09',
    label: '09 Menu — File',
    group: 'Screens',
    render: () => <Screen09Menu />,
    screen: { reference: ref09 },
  },
]

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

/** `?theme=dark` renders every page with the dark tokens (`<html data-theme>`). */
function initialTheme(): 'light' | 'dark' {
  return new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'
}
document.documentElement.dataset['theme'] = initialTheme()

function toggleTheme(): void {
  const next = document.documentElement.dataset['theme'] === 'dark' ? 'light' : 'dark'
  const url = new URL(window.location.href)
  url.searchParams.set('theme', next)
  window.history.replaceState(null, '', url)
  document.documentElement.dataset['theme'] = next
}

function useHashPath(): string {
  return useSyncExternalStore(subscribeHash, () => window.location.hash.replace(/^#\/?/, ''))
}

function App() {
  const hash = useHashPath()
  const [path] = hash.split('?')
  const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0]!

  useEffect(() => {
    document.title = `${route.label} · @baren/ui`
  }, [route])

  if (route.screen) {
    return <ScreenFrame reference={route.screen.reference}>{route.render()}</ScreenFrame>
  }

  return (
    <div className="pg">
      <nav className="pg-nav" aria-label="Playground pages">
        <h1>@baren/ui</h1>
        {(['Components', 'Screens'] as const).map((group) => (
          <NavGroup key={group} title={group}>
            {ROUTES.filter((r) => r.group === group).map((r) => (
              <NavItem
                key={r.path}
                active={r.path === route.path}
                onClick={() => {
                  window.location.hash = `/${r.path}`
                }}
              >
                {r.label}
              </NavItem>
            ))}
          </NavGroup>
        ))}
        <div className="pg-nav-group">Theme</div>
        <NavItem onClick={toggleTheme}>Toggle light / dark</NavItem>
      </nav>
      <main className="pg-main" key={route.path}>
        {route.render()}
      </main>
      <Toaster />
    </div>
  )
}

function NavGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="pg-nav-group">{title}</div>
      {children}
    </>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
