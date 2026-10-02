/**
 * The clipboard bridge inside Electron (contract §10.3): copy in window 1, paste in window 2
 * through `window.baren.clipboard`, with the real preload, IPC validation and main-process
 * clipboard (tests/visual/electron/clipboardHarness.ts). Opt-in, because it needs the built
 * preload: `pnpm --filter @baren/desktop build` (or `BAREN_ELECTRON_OUT=<outDir>`), then
 * `BAREN_ELECTRON_E2E=1 pnpm --filter @baren/desktop test:visual phase3-electron`.
 * Chromium runs with the headless Ozone platform: nothing is shown and the OS clipboard is
 * never touched.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const DESKTOP = resolve(__dirname, '../..')
const OUT = process.env['BAREN_ELECTRON_OUT'] ?? join(DESKTOP, 'out')
const PRELOAD = join(OUT, 'preload/index.js')

test.skip(!process.env['BAREN_ELECTRON_E2E'], 'set BAREN_ELECTRON_E2E=1 (needs a build)')

test('Electron: write in one window, read in another, through bridge.clipboard', async ({}, testInfo) => {
  expect(existsSync(PRELOAD), `built preload at ${PRELOAD}`).toBe(true)
  const require_ = createRequire(join(DESKTOP, 'package.json'))
  const esbuild = require_('esbuild') as typeof import('esbuild')
  const electron = require_('electron') as unknown as string
  const dir = testInfo.outputPath('harness')
  mkdirSync(dir, { recursive: true })
  const bundle = join(dir, 'harness.cjs')
  await esbuild.build({
    entryPoints: [join(__dirname, 'electron/clipboardHarness.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: bundle,
    logLevel: 'silent',
  })
  const run = spawnSync(electron, ['--ozone-platform=headless', '--disable-gpu', bundle], {
    env: { ...process.env, BAREN_HARNESS_PRELOAD: PRELOAD, ELECTRON_ENABLE_LOGGING: '0' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '))
  expect(line, `harness output:\n${run.stdout}\n${run.stderr}`).toBeTruthy()
  const result = JSON.parse((line as string).slice('RESULT '.length)) as Record<string, unknown>
  expect(result['error']).toBeUndefined()
  expect(result['bridge']).toBe(true)
  expect(result['read']).toMatchObject({
    text: 'Card',
    html: expect.stringContaining('Card'),
    baren: expect.stringContaining('"kind":"baren/clipboard"'),
    images: [],
  })
  expect(String(result['invalid'])).toMatch(/clipboard content object/)
  expect(result['items']).toBe(1)
  expect(result['types']).toEqual(
    expect.arrayContaining(['web application/x-baren-clipboard+json', 'text/plain', 'text/html']),
  )
  const images = result['images'] as [string, number][]
  expect(images).toHaveLength(1)
  expect(images[0]?.[0]).toBe('image/png')
  expect(images[0]?.[1]).toBeGreaterThan(0)
})
