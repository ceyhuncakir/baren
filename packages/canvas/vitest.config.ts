import { defineConfig } from 'vitest/config'

// Unit tests cover the pure modules (viewport math, hit testing, selection,
// resize, snapping, styles, keyboard, throttle). DOM behaviour is tested in
// real Chromium by the Playwright specs in tests/e2e and tests/perf.spec.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
})
