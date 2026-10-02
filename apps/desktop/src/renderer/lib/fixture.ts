/**
 * Design-fixture mode: `?fixture=design` in a plain browser (mock bridge only).
 *
 * The mock bridge then starts signed in and the API client is replaced by an in-memory fake
 * server holding the data shown in the reference artboards, so every screen renders without a
 * server (Playwright visual tests, design review). Never active inside Electron.
 *
 * Kept free of imports so lib/bridge.ts can depend on it without a cycle.
 */

function readFixtureParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('fixture')
  } catch {
    return null
  }
}

export const isDesignFixture: boolean =
  typeof window !== 'undefined' && window.baren === undefined && readFixtureParam() === 'design'

/** Session token the fixture mock bridge starts with. */
export const FIXTURE_TOKEN = 'fixture-session-token'
