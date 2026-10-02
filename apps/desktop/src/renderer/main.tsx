import '@baren/ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { initialLocation } from './app/lastRoute'
import { installTestHooks } from './lib/testHooks'
import { installUpdates } from './state/updates'
import { installTheme } from './state/theme'

// Before anything renders: <html data-theme> from the main process's resolved theme.
installTheme()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

// Hidden windows main opens for MCP agents (Phase 4 contract §11.6): a headless file host or
// the off-screen render window. No app shell, no last-route restore, no update checks.
const hash = window.location.hash
if (hash.startsWith('#/agent-host/') || hash === '#/agent-render') {
  void import('./agent/boot').then((m) => m.boot(root))
} else {
  // A window opened without a route resumes where the user left off.
  if (!hash || hash === '#' || hash === '#/') {
    window.history.replaceState(null, '', `#${initialLocation()}`)
  }

  installTestHooks()
  installUpdates()

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
