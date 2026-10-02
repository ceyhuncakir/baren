import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

// Component playground: `pnpm --filter @baren/ui playground` (http://127.0.0.1:5181)
// Screens import the reference PNGs from <repo>/design/reference for overlays.
export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5181,
    fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
  },
  build: {
    target: 'esnext',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
})
