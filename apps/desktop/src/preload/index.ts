/**
 * Preload (sandboxed, context-isolated). Exposes the complete
 * `BarenBridge` as `window.baren` — never a partial one: the renderer
 * treats any `window.baren` as complete and otherwise falls back to its
 * in-memory mock.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { createBridge, toPlatform } from './bridge'
import { createTypedIpc } from './ipc'
import { installMenuCommandForwarder } from './menuCommands'
import { reportStartupMilestones } from './startupReporter'
import { initialTheme } from './theme'

const ipc = createTypedIpc(ipcRenderer)

reportStartupMilestones((name, epochMs) => ipc.send('startup:milestone', name, epochMs))
installMenuCommandForwarder(ipc)

function navigationType(): string | null {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined
    return entry?.type ?? null
  } catch {
    return null
  }
}

const theme = initialTheme({
  argv: process.argv,
  navigationType: navigationType(),
  queryMain: () => ipc.sendSync('theme:get-resolved'),
  prefersDark: () => window.matchMedia('(prefers-color-scheme: dark)').matches,
})

try {
  contextBridge.exposeInMainWorld('baren', createBridge(ipc, toPlatform(process.platform), theme))
} catch (error) {
  // Only possible without context isolation, which main never configures.
  console.error('[baren] failed to expose the desktop bridge', error)
}
