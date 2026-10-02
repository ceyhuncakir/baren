import { defineConfig, devices } from '@playwright/test'

const PORT = 5181
const BASE_URL = `http://127.0.0.1:${PORT}`

/**
 * Gallery checks for the component playground (Vite dev server, plain Chromium) at the
 * reference artboard size. Screenshots are attached to the report; no golden diff here.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
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
    command: `pnpm exec vite --config playground/vite.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
})
