import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'

const root = fileURLToPath(new URL('.', import.meta.url))

// Perf bench + e2e harness pages: `pnpm --filter @baren/canvas bench`
export default defineConfig({
  root,
  plugins: [wasm()],
  // Use loro-crdt's ESM-wasm build in dev and prod (its "browser" build loads wasm via sync XHR).
  resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/bundler' }] },
  optimizeDeps: { exclude: ['loro-crdt'] },
  build: {
    target: 'esnext',
    outDir: fileURLToPath(new URL('../dist/bench', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        bench: fileURLToPath(new URL('./index.html', import.meta.url)),
        e2e: fileURLToPath(new URL('./e2e.html', import.meta.url)),
        react: fileURLToPath(new URL('./react.html', import.meta.url)),
        overlay: fileURLToPath(new URL('./overlay.html', import.meta.url)),
      },
    },
  },
  worker: { format: 'es', plugins: () => [wasm()] },
  server: { port: 5182 },
  preview: { port: 5183 },
})
