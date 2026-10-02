import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The e2e suite starts the real server binary.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
