/**
 * Editor environment: server URL and the browser-only design-fixture mode.
 *
 * Kept free of renderer imports so pure modules (fixtures, tests) can use it.
 */

/** Server base URL (ARCHITECTURE.md: VITE_SERVER_URL, default 127.0.0.1:8787). */
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? 'http://127.0.0.1:8787'

/** Public site, used for "Copy link" and the MCP docs link. */
export const SITE_URL = 'https://baren.dev'

export interface FixtureMode {
  /** `?fixture=design` in a plain browser (mock bridge): deterministic design data. */
  enabled: boolean
  /**
   * Optional `editorScene` query value selecting a document variant for a fixture file
   * (e.g. `theme` seeds the "Theme preview" artboard used by artboard 07).
   */
  scene: string | null
}

function readSearch(): URLSearchParams | null {
  try {
    return new URLSearchParams(window.location.search)
  } catch {
    return null
  }
}

/** Read once at startup; never active inside Electron (window.baren present). */
export function readFixtureMode(): FixtureMode {
  if (typeof window === 'undefined' || window.baren !== undefined) {
    return { enabled: false, scene: null }
  }
  const search = readSearch()
  const enabled = search?.get('fixture') === 'design'
  return { enabled, scene: enabled ? (search?.get('editorScene') ?? null) : null }
}

export const fixtureMode: FixtureMode = readFixtureMode()
