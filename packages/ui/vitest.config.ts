import { defineConfig } from 'vitest/config'

// Unit tests cover the pure logic in src/lib. Playwright specs in tests/ are separate.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
