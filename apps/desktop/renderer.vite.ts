import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import type { UserConfig } from 'vite'
import wasm from 'vite-plugin-wasm'

/**
 * Renderer build config shared by electron-vite (Electron) and
 * vite.web.config.ts (plain Chromium for Playwright / browser dev).
 */
export function rendererConfig(): UserConfig {
  return {
    root: resolve(__dirname, 'src/renderer'),
    // .env files live next to package.json, not in the renderer root.
    envDir: __dirname,
    plugins: [react(), wasm()],
    resolve: {
      alias: [
        { find: '@renderer', replacement: resolve(__dirname, 'src/renderer') },
        // loro-crdt's "browser" build loads its wasm with a synchronous XHR + sync
        // compile on the main thread. The bundler build imports the .wasm as an ES
        // module; vite-plugin-wasm turns that into async streaming instantiation.
        { find: /^loro-crdt$/, replacement: 'loro-crdt/bundler' },
      ],
    },
    // Pre-bundling would break loro-crdt's `import * as wasm from "./x.wasm"`.
    optimizeDeps: { exclude: ['loro-crdt'] },
    build: {
      // Electron 44 = Chromium 152: native top-level await, no down-levelling needed.
      target: 'esnext',
      // electron-vite disables minification by default; smaller bundles parse faster at cold start.
      minify: 'esbuild',
      modulePreload: { polyfill: false },
    },
    worker: { format: 'es', plugins: () => [wasm()] },
  }
}
