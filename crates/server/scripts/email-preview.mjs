#!/usr/bin/env node
/**
 * Render the email templates and compare them with the reference artboards 26–28.
 *
 *   node crates/server/scripts/email-preview.mjs [outDir]
 *
 * 1. `cargo test -p baren-server write_previews` renders each email (with the artboards'
 *    sample data) to `<outDir>/<kind>.html` (+ `.txt`).
 * 2. Headless Chromium (Playwright, no visible window) screenshots each one at 600 px wide,
 *    twice: with Inter/JetBrains Mono injected from node_modules (like the artboards, and like
 *    clients that have the fonts) and as-is (system fallback fonts, like most mail clients).
 * 3. The font-matched screenshot is compared with design/reference/2{6,7,8}-*.png pixel by
 *    pixel (pixelmatch-style YIQ delta, threshold 0.1, inside the browser via <canvas>), and a
 *    diff image is written. Prints one line per email.
 *
 * Exit code 1 when a mismatch exceeds EMAIL_MAX_MISMATCH (default 3 %: these 600 px frames are
 * mostly text, and glyphs rasterise up to 1 px off from the reference renderer; layout differences
 * show up as whole shifted blocks and far larger numbers).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const outDir = resolve(process.argv[2] ?? join(repo, 'target/p2-server/email-preview'))
const maxMismatch = Number(process.env.EMAIL_MAX_MISMATCH ?? '0.03')
mkdirSync(outDir, { recursive: true })

const emails = [
  { kind: 'verification_code', ref: '26-' },
  { kind: 'password_reset', ref: '27-' },
  { kind: 'team_invite', ref: '28-' },
]

if (!process.env.SKIP_RENDER) {
  execFileSync(
    'cargo',
    ['test', '-p', 'baren-server', '--lib', '--offline', '--', 'write_previews'],
    {
      cwd: repo,
      stdio: 'inherit',
      env: {
        ...process.env,
        BAREN_EMAIL_PREVIEW_DIR: outDir,
        CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(repo, 'target/p2-server'),
      },
    },
  )
}

const font = (rel) => pathToFileURL(join(repo, 'node_modules', rel)).href
const fontFaces = `<style>
@font-face { font-family: Inter; font-weight: 100 900; font-style: normal;
  src: url("${font('@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2')}") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 400; font-style: normal;
  src: url("${font('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2')}") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 600; font-style: normal;
  src: url("${font('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2')}") format("woff2"); }
body { font-synthesis: none; }
</style>`
const markUri = `data:image/png;base64,${readFileSync(join(repo, 'crates/server/assets/baren-mark.png')).toString('base64')}`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 1 })
const refDir = join(repo, 'design/reference')
let failed = false

for (const { kind, ref } of emails) {
  // Mail clients resolve `cid:baren-mark` from the message's inline attachment; a browser cannot.
  const html = readFileSync(join(outDir, `${kind}.html`), 'utf8').replaceAll(
    'cid:baren-mark',
    markUri,
  )
  const htmlPath = join(outDir, `${kind}.preview.html`)
  writeFileSync(htmlPath, html)
  const withFonts = join(outDir, `${kind}.fonts.html`)
  writeFileSync(withFonts, html.replace('</head>', `${fontFaces}</head>`))

  await page.goto(pathToFileURL(htmlPath).href)
  await page.screenshot({ path: join(outDir, `${kind}.fallback.png`), fullPage: true })
  await page.goto(pathToFileURL(withFonts).href)
  await page.evaluate(() => document.fonts.ready)
  const actual = await page.screenshot({ path: join(outDir, `${kind}.png`), fullPage: true })

  const refName = readdirSync(refDir).find((f) => f.startsWith(ref) && f.endsWith('.png'))
  if (!refName) {
    console.log(`${kind}: no reference ${ref}*.png yet`)
    continue
  }
  const expected = readFileSync(join(refDir, refName))
  const result = await page.evaluate(
    async ({ a, b }) => {
      const load = (b64) =>
        new Promise((res, rej) => {
          const img = new Image()
          img.onload = () => res(img)
          img.onerror = rej
          img.src = `data:image/png;base64,${b64}`
        })
      const [ia, ib] = await Promise.all([load(a), load(b)])
      const w = Math.max(ia.width, ib.width)
      const h = Math.max(ia.height, ib.height)
      const pixels = (img) => {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, w, h).data
      }
      const pa = pixels(ia)
      const pb = pixels(ib)
      const diff = document.createElement('canvas')
      diff.width = w
      diff.height = h
      const dctx = diff.getContext('2d')
      const out = dctx.createImageData(w, h)
      // pixelmatch's YIQ metric; 35215 is the maximum squared delta.
      const maxDelta = 35215 * 0.1 * 0.1
      let bad = 0
      for (let i = 0; i < pa.length; i += 4) {
        const [r1, g1, b1] = [pa[i], pa[i + 1], pa[i + 2]]
        const [r2, g2, b2] = [pb[i], pb[i + 1], pb[i + 2]]
        const y = (r, g, b) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223
        const iq = (r, g, b) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189
        const q = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694
        const dy = y(r1, g1, b1) - y(r2, g2, b2)
        const di = iq(r1, g1, b1) - iq(r2, g2, b2)
        const dq = q(r1, g1, b1) - q(r2, g2, b2)
        const delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq
        const gray = 255 - 0.1 * (255 - y(r2, g2, b2))
        if (delta > maxDelta) {
          bad++
          out.data.set([255, 0, 0, 255], i)
        } else {
          out.data.set([gray, gray, gray, 255], i)
        }
      }
      dctx.putImageData(out, 0, 0)
      return {
        mismatch: bad / (w * h),
        actual: [ia.width, ia.height],
        expected: [ib.width, ib.height],
        diff: diff.toDataURL('image/png').split(',')[1],
      }
    },
    { a: actual.toString('base64'), b: expected.toString('base64') },
  )
  writeFileSync(join(outDir, `${kind}.diff.png`), Buffer.from(result.diff, 'base64'))
  const pct = (result.mismatch * 100).toFixed(2)
  const ok = result.mismatch <= maxMismatch
  failed ||= !ok
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${kind}: ${pct}% of pixels differ from ${refName} ` +
      `(actual ${result.actual.join('×')}, reference ${result.expected.join('×')}); ` +
      `diff: ${join(outDir, `${kind}.diff.png`)}`,
  )
}

await browser.close()
if (!existsSync(outDir)) process.exit(1)
process.exit(failed ? 1 : 0)
