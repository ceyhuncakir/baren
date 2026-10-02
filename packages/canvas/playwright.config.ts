import { defineConfig, devices } from '@playwright/test'

const PORT = 5183
const BASE_URL = `http://127.0.0.1:${PORT}`

/**
 * Canvas e2e + perf specs run against a production build of the bench pages
 * (bench/index.html = perf bench, bench/e2e.html = fixture) in Chromium.
 *
 * The perf project launches Chromium with vsync and the frame-rate limit
 * disabled so rAF intervals reflect real throughput instead of 60 Hz.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'e2e',
      testMatch: /e2e\/.*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'perf',
      testMatch: /perf\.spec\.ts$/,
      timeout: 600_000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        launchOptions: { args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] },
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite build --config bench/vite.config.ts && pnpm exec vite preview --config bench/vite.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `${BASE_URL}/e2e.html`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
})
