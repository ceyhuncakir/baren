/**
 * Entry of the hidden windows main opens for MCP agents (contract §11.1, §11.6), loaded by
 * `main.tsx` with a dynamic import so normal windows never pay for it:
 *
 *  - `#/agent-host/<fileId>` → `HeadlessHost` (a file host without a visible window);
 *  - `#/agent-render` → `RenderRoot` (the off-screen render window).
 *
 * No StrictMode: a double mount would open the file twice.
 */
import { createRoot } from 'react-dom/client'
import { HeadlessHost } from './host/HeadlessHost'
import { RenderRoot } from './render/RenderRoot'

export const AGENT_HOST_PREFIX = '#/agent-host/'
export const AGENT_RENDER_HASH = '#/agent-render'

export function boot(root: HTMLElement): void {
  const hash = window.location.hash
  const app = createRoot(root)
  if (hash === AGENT_RENDER_HASH) {
    app.render(<RenderRoot />)
    return
  }
  let fileId = hash.slice(AGENT_HOST_PREFIX.length)
  try {
    fileId = decodeURIComponent(fileId)
  } catch {
    // Keep the raw id.
  }
  app.render(<HeadlessHost fileId={fileId} />)
}
