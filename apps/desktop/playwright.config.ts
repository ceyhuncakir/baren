import { defineConfig, devices } from '@playwright/test'

const PORT = 5199
const BASE_URL = `http://127.0.0.1:${PORT}`

/**
 * Visual tests run the renderer in plain Chromium against the Vite dev server
 * (mock bridge, no Electron) at the reference artboard size of 1440×900.
 */
export default defineConfig({
  testDir: './tests/visual',
  outputDir: './test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' },
  },
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --config vite.web.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
})
