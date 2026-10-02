/**
 * Builds the stdio shim (`shim.ts`) into one self-contained CommonJS file, `mcp-stdio.js`
 * (contract §4.12). Used by electron.vite.config.ts after the main bundle (so the shim never
 * shares chunks with the app) and by the shim test. Build tooling only: never imported by the
 * app.
 */
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { build, type Plugin } from 'vite'

export const SHIM_FILE_NAME = 'mcp-stdio.js'

export interface ShimBuildOptions {
  /** apps/desktop */
  root: string
  /** Where `mcp-stdio.js` goes (normally out/main). */
  outDir: string
  minify?: boolean
}

const NODE_BUILTINS = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

export async function buildMcpShim(options: ShimBuildOptions): Promise<string> {
  await build({
    configFile: false,
    root: options.root,
    logLevel: 'warn',
    publicDir: false,
    resolve: { conditions: ['node', 'import', 'module', 'default'] },
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: join(options.root, 'src/main/mcp/stdio/shim.ts'),
      outDir: options.outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'node18',
      minify: options.minify ?? false,
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: {
        external: NODE_BUILTINS,
        output: {
          format: 'cjs',
          entryFileNames: SHIM_FILE_NAME,
          inlineDynamicImports: true,
        },
      },
    },
  })
  return join(options.outDir, SHIM_FILE_NAME)
}

/** electron-vite main plugin: build the shim into the main output after each main build. */
export function mcpShimPlugin(root: string): Plugin {
  let outDir = join(root, 'out/main')
  return {
    name: 'baren:mcp-stdio-shim',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    async closeBundle() {
      await buildMcpShim({ root, outDir })
    },
  }
}
