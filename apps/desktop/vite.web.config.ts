import { resolve } from 'node:path'
import { defineConfig, mergeConfig } from 'vite'
import { rendererConfig } from './renderer.vite'

/**
 * The renderer alone, served to plain Chromium (no Electron). `window.baren`
 * is absent here, so lib/bridge.ts falls back to the in-memory mock bridge.
 * Used by `dev:web`, `preview:web` and the Playwright visual tests.
 */
export const WEB_PORT = 5199

export default defineConfig(
  mergeConfig(rendererConfig(), {
    base: './',
    build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true },
    server: { port: WEB_PORT, strictPort: true },
    preview: { port: WEB_PORT, strictPort: true },
  }),
)
