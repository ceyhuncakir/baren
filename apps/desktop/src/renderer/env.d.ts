/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the baren server. Default: http://127.0.0.1:8787 */
  readonly VITE_SERVER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
