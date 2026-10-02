import { defineConfig } from '@playwright/test'

/**
 * MCP end-to-end runs (contract docs/phase4/contract.md §14.5): the built Electron app, hidden
 * (`--ozone-platform=headless`), with a scratch profile, an ephemeral MCP port and an SDK client.
 * Opt-in: `pnpm --filter @baren/desktop build`, then
 * `BAREN_MCP_E2E=1 pnpm --filter @baren/desktop exec playwright test -c tests/mcp/playwright.config.ts`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: '../../test-results/mcp',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 300_000,
})
