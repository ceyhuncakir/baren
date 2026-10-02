/**
 * Hooks for tests and design review, exposed as `window.__barenTest` whenever the
 * renderer runs on the in-memory mock bridge (plain browser, Playwright). Never installed
 * inside Electron. They act on the app's own module instances, which a test cannot reach
 * through dynamic imports once Vite has hot-reloaded a module.
 */
import { useFiles } from '../state/files'
import type { UpdateState, UpdateStatus } from '../types/bridge'
import { bridge, mockControls } from './bridge'
import { registerCommand, type CommandId } from './commands'

export interface TestHooks {
  /** Registers a recording handler so the command shows as enabled; returns the unregister. */
  enableCommand(id: CommandId): () => void
  /** Commands run through enableCommand handlers, oldest first. */
  commandCalls(): readonly string[]
  emitDeepLink(url: string): void
  openedUrls(): readonly string[]
  /** Creates `count` local files named `<prefix> <i>` and reloads the file list. */
  createFiles(count: number, prefix: string): Promise<void>
  /** Pushes an auto-update status, as the main process would. */
  setUpdateStatus(status: UpdateState | UpdateStatus): void
  /** How many times `updates.install()` ran while an update was ready. */
  updateInstalls(): number
  /** Simulates the OS switching dark mode (the 'system' theme follows it). */
  setSystemDark(dark: boolean): void
}

declare global {
  interface Window {
    __barenTest?: TestHooks
  }
}

export function installTestHooks(): void {
  const controls = mockControls
  if (!controls || typeof window === 'undefined') return
  const calls: string[] = []
  window.__barenTest = {
    enableCommand: (id) => registerCommand(id, () => void calls.push(id)),
    commandCalls: () => [...calls],
    emitDeepLink: (url) => controls.emitDeepLink(url),
    openedUrls: () => controls.openedUrls(),
    async createFiles(count, prefix) {
      for (let i = 0; i < count; i++) await bridge.files.create(`${prefix} ${i}`)
      await useFiles.getState().load()
    },
    setUpdateStatus: (status) => controls.setUpdateStatus(status),
    updateInstalls: () => controls.updateInstalls(),
    setSystemDark: (dark) => controls.setSystemDark(dark),
  }
}
