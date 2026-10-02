import { defineConfig } from 'electron-vite'
import { mcpShimPlugin } from './src/main/mcp/stdio/build'
import { rendererConfig } from './renderer.vite'

/** Workspace packages ship TypeScript sources, so they must be bundled, never externalized. */
const WORKSPACE_PACKAGES = [
  '@baren/schema',
  '@baren/sync-client',
  '@baren/canvas',
  '@baren/ui',
  '@baren/html',
]

export default defineConfig({
  main: {
    resolve: {
      alias: [
        // The JS core worker bundles Loro. loro-crdt's Node build reads its .wasm
        // relative to its own file, which bundling breaks; the web build is
        // initialised explicitly from the copied .wasm (src/main/core/js/worker.ts).
        { find: /^loro-crdt$/, replacement: 'loro-crdt/web' },
      ],
    },
    build: {
      // Everything is a devDependency and gets bundled: the packaged app ships only out/.
      externalizeDeps: { exclude: WORKSPACE_PACKAGES },
    },
    // The MCP stdio shim (src/main/mcp/stdio/shim.ts) is a second main output, out/main/mcp-stdio.js:
    // built separately after the main bundle so it is one self-contained CommonJS file (it is
    // copied out of the app and run with plain Node; contract docs/phase4/contract.md §4.12).
    plugins: [mcpShimPlugin(__dirname)],
  },
  preload: {
    // Sandboxed preloads cannot require() dependencies: bundle everything (electron stays external).
    build: { externalizeDeps: false },
  },
  renderer: rendererConfig(),
})
