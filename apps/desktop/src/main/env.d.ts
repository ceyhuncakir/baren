/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Sync server base URL, shared with the renderer (`lib/env.ts`); used for the CSP. */
  readonly VITE_SERVER_URL?: string
  /** Auto-update feed (electron-updater generic provider); default `<VITE_SERVER_URL>/updates/`. */
  readonly VITE_UPDATE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Text of a bundled file (`docs/phase4/guide.md?raw`, the MCP guide). */
declare module '*?raw' {
  const text: string
  export default text
}
