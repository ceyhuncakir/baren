/**
 * Visual fidelity of the screens workstream against the reference PNGs
 * (design/reference/*.png, 1440×900). The renderer runs in plain Chromium with the mock
 * bridge and the design fixture (`?fixture=design`), and every screenshot is compared pixel
 * by pixel with a small, self-contained PNG decoder and a pixelmatch-style YIQ color delta.
 *
 * Each test logs its mismatch percentage and attaches actual/expected/diff images.
 * Menus 09–13 sit on top of the editor (another workstream), so their asserted number is
 * for the title bar plus the open menu; the full-frame number is logged for information.
 *
 * Known, accepted differences: no Billing tab (02/03) and no "Pro" badges (01–03, 17)
 * (product decision), the text caret in focused fields, the "Sign in with browser ·
 * Continue offline" links added to the auth footer (18/19), the app version next to
 * "Check for Updates…" (13), and the verify tip (20): the verification email has no link,
 * so the tip no longer promises one.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import { readReference } from './references'

const REFERENCE_DIR = resolve(__dirname, '../../../../design/reference')
/** All "Edited …" / "Resend in 0:24" labels are computed from this fixed clock. */
const FIXED_NOW = new Date('2026-10-02T12:00:00Z')

/* ------------------------------------------------------------------ PNG codec */

interface Image {
  width: number
  height: number
  /** RGBA, 8 bits per channel. */
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decodes 8-bit, non-interlaced RGB/RGBA PNGs (Playwright screenshots and reference exports). */
function decodePng(file: Buffer): Image {
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('ascii', offset + 4, offset + 8)
    const body = file.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const bitDepth = body[8]
      colorType = body[9] ?? 0
      const interlace = body[12]
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0)
        throw new Error(
          `unsupported PNG (depth ${bitDepth}, color ${colorType}, interlace ${interlace})`,
        )
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x] ?? 0
      const left = x >= bpp ? (pixels[dst + x - bpp] ?? 0) : 0
      const up = y > 0 ? (pixels[dst - stride + x] ?? 0) : 0
      const upLeft = y > 0 && x >= bpp ? (pixels[dst - stride + x - bpp] ?? 0) : 0
      let out: number
      switch (filter) {
        case 0:
          out = value
          break
        case 1:
          out = value + left
          break
        case 2:
          out = value + up
          break
        case 3:
          out = value + ((left + up) >> 1)
          break
        case 4:
          out = value + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`bad PNG filter ${filter}`)
      }
      pixels[dst + x] = out & 0xff
    }
  }
  if (bpp === 4) return { width, height, data: pixels }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i] ?? 0
    rgba[j + 1] = pixels[i + 1] ?? 0
    rgba[j + 2] = pixels[i + 2] ?? 0
    rgba[j + 3] = 255
  }
  return { width, height, data: rgba }
}

function encodePng(image: Image): Buffer {
  const { width, height, data } = image
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    )
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ diff */

interface Region {
  x: number
  y: number
  width: number
  height: number
}

interface DiffResult {
  /** Share of differing pixels in the region, in percent. */
  percent: number
  differing: number
  total: number
  diff: Image
}

/** Squared YIQ distance of two pixels blended on white (pixelmatch's color metric). */
function colorDelta(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  const blend = (c: number, alpha: number) => 255 + ((c - 255) * alpha) / 255
  const aa = a[i + 3] ?? 255
  const ba = b[j + 3] ?? 255
  const r1 = blend(a[i] ?? 0, aa)
  const g1 = blend(a[i + 1] ?? 0, aa)
  const b1 = blend(a[i + 2] ?? 0, aa)
  const r2 = blend(b[j] ?? 0, ba)
  const g2 = blend(b[j + 1] ?? 0, ba)
  const b2 = blend(b[j + 2] ?? 0, ba)
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223
  const iq = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q
}

const inRegions = (regions: readonly Region[], x: number, y: number) =>
  regions.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)

/** Counts pixels whose color differs by more than `threshold` (0–1, pixelmatch scale). */
function compareImages(
  actual: Image,
  expected: Image,
  regions: readonly Region[],
  threshold = 0.1,
): DiffResult {
  expect(actual.width).toBe(expected.width)
  expect(actual.height).toBe(expected.height)
  const { width, height } = actual
  const maxDelta = 35215 * threshold * threshold
  const diff = new Uint8Array(width * height * 4)
  let differing = 0
  let total = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const inside = inRegions(regions, x, y)
      const gray =
        255 -
        (255 -
          ((expected.data[i] ?? 0) * 0.3 +
            (expected.data[i + 1] ?? 0) * 0.59 +
            (expected.data[i + 2] ?? 0) * 0.11)) *
          0.15
      if (!inside) {
        diff.set([gray, gray, gray, 255], i)
        continue
      }
      total++
      if (colorDelta(actual.data, i, expected.data, i) > maxDelta) {
        differing++
        diff.set([255, 0, 0, 255], i)
      } else {
        diff.set([gray, gray, gray, 255], i)
      }
    }
  }
  return {
    percent: total === 0 ? 0 : (differing / total) * 100,
    differing,
    total,
    diff: { width, height, data: diff },
  }
}

/* ------------------------------------------------------------------ helpers */

const FULL: Region = { x: 0, y: 0, width: 1440, height: 900 }

/*
 * Tolerances. What remains after layout matches is text rasterization: the references' renderer
 * places some glyph runs one pixel lower than Chromium (13px/16px menu rows, the 14/22
 * auth leads) and anti-aliases differently. Measured: 0.6–1.25 % per full frame; the menu
 * regions are text-dense, so the same effect reads 3–4.5 % there.
 */
const FULL_FRAME_MAX = 1.6
const MENU_REGION_MAX = 5

async function openScreen(page: Page, hash: string, query = ''): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`/?fixture=design${query}#${hash}`)
  await page.waitForFunction('document.fonts.status === "loaded"')
  expect(errors, 'page errors').toEqual([])
}

/** Every <img> has decoded (thumbnails), then two frames for layout to settle. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    '[...document.images].every((img) => img.complete && img.naturalWidth > 0)',
  )
  await page.evaluate(
    '(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })()',
  )
}

interface CheckOptions {
  /** Reference file in design/reference. */
  reference: string
  /** Asserted regions (default: the whole frame). */
  regions?: readonly Region[]
  /** Maximum differing pixels in the regions, percent. */
  maxPercent: number
}

async function checkScreen(page: Page, testInfo: TestInfo, options: CheckOptions): Promise<void> {
  await settle(page)
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const expectedPng = readReference(resolve(REFERENCE_DIR, options.reference), png)
  const actual = decodePng(png)
  const expected = decodePng(expectedPng)
  const full = compareImages(actual, expected, [FULL])
  const scoped = options.regions ? compareImages(actual, expected, options.regions) : full

  const diffPng = encodePng(scoped.diff)
  // Kept on disk for every run (test-results/<test>/), not only for failures.
  writeFileSync(testInfo.outputPath('actual.png'), png)
  writeFileSync(testInfo.outputPath('diff.png'), diffPng)
  await testInfo.attach('actual', { body: png, contentType: 'image/png' })
  await testInfo.attach('expected', { body: expectedPng, contentType: 'image/png' })
  await testInfo.attach('diff', { body: diffPng, contentType: 'image/png' })

  const label = options.reference.replace(/\.png$/, '')
  const scopedText = options.regions
    ? ` | ${options.regions.map((r) => `${r.width}×${r.height}@${r.x},${r.y}`).join(' + ')}: ${scoped.percent.toFixed(2)}%`
    : ''
  console.log(`[visual] ${label}: full ${full.percent.toFixed(2)}%${scopedText}`)
  testInfo.annotations.push({
    type: 'mismatch',
    description: `${full.percent.toFixed(2)}% full${scopedText}`,
  })
  expect(scoped.percent, `${label} differing pixels (%)`).toBeLessThanOrEqual(options.maxPercent)
}

/**
 * The title bar plus the open menu panel. The panel is opaque, so this excludes the editor
 * underneath (and the panel's soft shadow, which blends with it).
 */
async function menuRegions(page: Page): Promise<Region[]> {
  const box = await page.locator('[data-floating-layer] [role="menu"]').boundingBox()
  if (!box) throw new Error('menu not open')
  // Inset 2px: the 10px rounded corners show the editor through their anti-aliasing.
  const inset = 2
  return [
    { x: 0, y: 0, width: 1440, height: 36 },
    {
      x: Math.ceil(box.x) + inset,
      y: Math.ceil(box.y) + inset,
      width: Math.floor(box.width) - 2 * inset,
      height: Math.floor(box.height) - 2 * inset,
    },
  ]
}

async function openMenu(page: Page, title: string, hover: string): Promise<void> {
  await page.locator('[data-menubar-item]', { hasText: title }).click()
  const menu = page.getByRole('menu', { name: title })
  await expect(menu).toBeVisible()
  await menu.getByText(hover, { exact: true }).hover()
}

/* ------------------------------------------------------------------ screens */

test.describe('screens vs references', () => {
  test('01 Home — Recents', async ({ page }, testInfo) => {
    await openScreen(page, '/recents')
    await expect(page.getByTestId('file-grid').locator('img')).toHaveCount(7)
    await checkScreen(page, testInfo, {
      reference: '01-home-recents.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('02 Team — Members', async ({ page }, testInfo) => {
    await openScreen(page, '/team/members')
    await expect(page.getByText('mert@example.com')).toBeVisible()
    await expect(page.getByText('Defne Aydın')).toBeVisible()
    await checkScreen(page, testInfo, {
      reference: '02-team-members.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('03 Team — Settings', async ({ page }, testInfo) => {
    await openScreen(page, '/team/settings')
    await expect(page.getByLabel('Team name')).toHaveValue("ceyhun's Team")
    await checkScreen(page, testInfo, {
      reference: '03-team-settings.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  const MENUS = [
    { ref: '09-menu-file.png', title: 'File', hover: 'New Window' },
    { ref: '10-menu-edit.png', title: 'Edit', hover: 'Copy' },
    { ref: '11-menu-view.png', title: 'View', hover: 'Toggle Developer Tools' },
    { ref: '12-menu-window.png', title: 'Window', hover: 'Minimize' },
    { ref: '13-menu-help.png', title: 'Help', hover: 'Documentation' },
  ] as const

  for (const m of MENUS) {
    test(`${m.ref.slice(0, 2)} Menu — ${m.title}`, async ({ page }, testInfo) => {
      await openScreen(page, '/file/f-baren')
      await expect(page.locator('header').getByText('Baren', { exact: true })).toBeVisible()
      // The editor chunk loads lazily; let it render before opening the menu.
      await page.waitForLoadState('networkidle')
      if (m.title === 'Edit') {
        // 10 shows an editor with undo history: everything but Redo is enabled.
        await page.evaluate(`(() => {
          const hooks = window.__barenTest
          for (const id of ['edit.undo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll'])
            hooks.enableCommand(id)
        })()`)
      }
      await openMenu(page, m.title, m.hover)
      await checkScreen(page, testInfo, {
        reference: m.ref,
        regions: await menuRegions(page),
        maxPercent: MENU_REGION_MAX,
      })
    })
  }

  test('17 Home — Account menu', async ({ page }, testInfo) => {
    await openScreen(page, '/recents')
    await expect(page.getByTestId('file-grid').locator('img')).toHaveCount(7)
    await page.getByRole('button', { name: 'Account menu: ceyhun cakir' }).click()
    await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible()
    await checkScreen(page, testInfo, {
      reference: '17-home-account-menu.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('18 Auth — Sign in', async ({ page }, testInfo) => {
    await openScreen(page, '/auth/sign-in')
    await page.getByLabel('Email').fill('ceyhun@example.com')
    await checkScreen(page, testInfo, {
      reference: '18-auth-sign-in.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('19 Auth — Create account', async ({ page }, testInfo) => {
    await openScreen(page, '/auth/register')
    await page.getByLabel('Full name').fill('Defne Aydın')
    await page.getByLabel('Work email').fill('defne@example.com')
    await page.getByText('I agree to the Terms').click()
    await page.getByLabel('Password', { exact: true }).fill('barenpad26x')
    await expect(page.getByText('Good', { exact: true })).toBeVisible()
    await checkScreen(page, testInfo, {
      reference: '19-auth-create-account.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('20 Auth — Verify email', async ({ page }, testInfo) => {
    await openScreen(page, '/auth/verify')
    await page.getByLabel('Verification code').pressSequentially('4827')
    await expect(page.getByText('Resend in 0:24')).toBeVisible()
    await checkScreen(page, testInfo, {
      reference: '20-auth-verify-email.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('21 Auth — Continue in browser', async ({ page }, testInfo) => {
    await openScreen(page, '/auth/browser')
    await expect(page.getByText('KQ7-4XM')).toBeVisible()
    await checkScreen(page, testInfo, {
      reference: '21-auth-continue-in-browser.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('22 Auth — Forgot password', async ({ page }, testInfo) => {
    await openScreen(page, '/auth/forgot')
    await page.getByLabel('Email').fill('ceyhun@example.com')
    await checkScreen(page, testInfo, {
      reference: '22-auth-forgot-password.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('23 Auth — Reset password', async ({ page }, testInfo) => {
    await openScreen(page, '/auth/reset')
    await page.getByLabel('Reset code').pressSequentially('482719')
    // A complete code moves on to the new password.
    const password = page.getByLabel('New password', { exact: true })
    await expect(password).toBeFocused()
    await page.keyboard.type('barenpad26x')
    await expect(page.getByText('Good', { exact: true })).toBeVisible()
    await expect(page.getByText('Resend in 0:24')).toBeVisible()
    await checkScreen(page, testInfo, {
      reference: '23-auth-reset-password.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })

  test('25 App — Update ready', async ({ page }, testInfo) => {
    await openScreen(page, '/recents', '&updates=ready')
    await expect(page.getByTestId('file-grid').locator('img')).toHaveCount(7)
    await expect(page.getByText('Version 0.2.0 is ready')).toBeVisible()
    await checkScreen(page, testInfo, {
      reference: '25-app-update-ready.png',
      maxPercent: FULL_FRAME_MAX,
    })
  })
})

/* ------------------------------------------------------------------ behaviour */

/** Calls a test hook in the page (window.__barenTest, mock bridge only). */
async function hook<T>(page: Page, expression: string): Promise<T> {
  return (await page.evaluate(
    `(() => { const h = window.__barenTest; return ${expression} })()`,
  )) as T
}

async function openFixture(page: Page, hash: string): Promise<void> {
  await openScreen(page, hash)
  await page.waitForLoadState('networkidle')
}

test.describe('screens behaviour', () => {
  test('Alt focuses the menu bar; arrows, Enter and Escape drive the menus', async ({ page }) => {
    await openFixture(page, '/recents')
    await page.keyboard.press('Alt')
    await expect(page.locator('[data-menubar-item]', { hasText: 'File' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-menubar-item]', { hasText: 'Edit' })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Enter')
    const file = page.getByRole('menu', { name: 'File' })
    await expect(file).toBeVisible()
    await expect(file.getByRole('menuitem', { name: /New Window/ })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menu', { name: 'Edit' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.locator('[data-menubar-item]', { hasText: 'Edit' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-menubar-item]', { hasText: 'Edit' })).not.toBeFocused()
  })

  test('an open menu switches on hover; Help links open externally', async ({ page }) => {
    await openFixture(page, '/recents')
    await page.locator('[data-menubar-item]', { hasText: 'File' }).click()
    await page.locator('[data-menubar-item]', { hasText: 'Help' }).hover()
    const help = page.getByRole('menu', { name: 'Help' })
    await expect(help).toBeVisible()
    await help.getByText('Documentation').click()
    await expect(help).toBeHidden()
    expect(await hook<string[]>(page, 'h.openedUrls()')).toContain('https://baren.dev/docs')
  })

  test('Edit items follow the command registry; shortcuts run commands outside text fields', async ({
    page,
  }) => {
    await openFixture(page, '/recents')
    await page.locator('[data-menubar-item]', { hasText: 'Edit' }).click()
    await expect(page.getByRole('menuitem', { name: /Undo/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await page.keyboard.press('Escape')
    await hook(page, "h.enableCommand('edit.undo')")
    await page.locator('[data-menubar-item]', { hasText: 'Edit' }).click()
    const undo = page.getByRole('menuitem', { name: /Undo/ })
    await expect(undo).not.toHaveAttribute('aria-disabled', 'true')
    await undo.click()
    await page.keyboard.press('Control+z')
    expect(await hook<string[]>(page, 'h.commandCalls()')).toEqual(['edit.undo', 'edit.undo'])
    // In a text field, Ctrl+Z is the field's own undo.
    await page.getByRole('searchbox', { name: 'Search files' }).click()
    await page.keyboard.press('Control+z')
    expect(await hook<string[]>(page, 'h.commandCalls()')).toHaveLength(2)
  })

  test('Ctrl+F searches files; Ctrl+/ lists shortcuts', async ({ page }) => {
    await openFixture(page, '/recents')
    await page.keyboard.press('Control+f')
    await expect(page.getByRole('searchbox', { name: 'Search files' })).toBeFocused()
    await page.keyboard.type('dash')
    await expect(page.locator('[data-file-id]')).toHaveCount(1)
    await expect(page.getByText('acme dashboard')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-file-id]')).toHaveCount(8)
    await page.keyboard.press('Control+/')
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('file cards: rename, archive, restore, delete; list view', async ({ page }) => {
    await openFixture(page, '/recents')
    await page.getByRole('button', { name: /^logo/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename file' })
    await dialog.getByLabel('File name').fill('logo v2')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: /^logo v2/ })).toBeVisible()

    await page.getByRole('button', { name: /^cv/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Archive' }).click()
    await expect(page.getByRole('button', { name: /^cv/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(page).toHaveURL(/#\/archive$/)
    await page.getByRole('button', { name: /^cv/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete…' }).click()
    await page
      .getByRole('dialog', { name: 'Delete file?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(page.getByText('Nothing archived')).toBeVisible()

    await page.getByRole('button', { name: 'Recents', exact: true }).click()
    await page.getByRole('radio', { name: 'List view' }).click()
    await expect(page.getByRole('grid')).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: 'acme darkmode' })).toBeVisible()
  })

  test('New file opens the editor and the title follows the file', async ({ page }) => {
    await openFixture(page, '/recents')
    await page.getByRole('button', { name: 'New file' }).click()
    await expect(page).toHaveURL(/#\/file\//)
    await expect(page.locator('header').getByText('Untitled', { exact: true })).toBeVisible()
    await expect(page).toHaveTitle(/Untitled/)
  })

  test('team: invite, change a role, revoke, rename and delete the team', async ({ page }) => {
    await openFixture(page, '/team/members')
    await page
      .getByRole('region', { name: "ceyhun's Team settings" })
      .getByRole('button', { name: 'Invite members' })
      .click()
    const invite = page.getByRole('dialog', { name: 'Invite members' })
    await expect(invite.getByRole('button', { name: 'Create invite link' })).toBeVisible()
    await invite.getByLabel('Email (optional)').fill('zeynep@example.com')
    // The fixture server delivers email: an address turns the invite into an email.
    await invite.getByRole('button', { name: 'Send invite' }).click()
    await expect(page.getByText('Invite sent to zeynep@example.com')).toBeVisible()
    await expect(invite.getByText(/We emailed zeynep@example.com/)).toBeVisible()
    await expect(invite.getByLabel('Invite link')).toHaveValue(/\/i\//)
    await invite.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText('zeynep@example.com', { exact: true })).toBeVisible()
    await expect(page.getByText('4 members')).toBeVisible()

    // Resending mails the invite again (the server rotates its link).
    await page
      .getByRole('row')
      .filter({ hasText: 'zeynep@example.com' })
      .getByRole('button', { name: 'Resend invite' })
      .click()
    await expect(page.getByText('Invite sent again to zeynep@example.com')).toBeVisible()

    await page.getByRole('button', { name: 'Role for Defne Aydın' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Viewer' }).click()
    await expect(page.getByText('Defne Aydın is now viewer')).toBeVisible()

    await page
      .getByRole('row')
      .filter({ hasText: 'mert@example.com' })
      .getByRole('button', { name: 'Revoke' })
      .click()
    await expect(page.getByText('mert@example.com')).toHaveCount(0)

    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/#\/team\/settings$/)
    const name = page.getByLabel('Team name')
    await name.fill('Studio')
    await name.press('Enter')
    await expect(page.getByRole('heading', { name: 'Studio settings' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Team' }).getByText('Studio')).toBeVisible()

    await page.getByRole('button', { name: 'File access' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Only team members' }).click()
    await expect(page.getByRole('button', { name: 'File access' })).toContainText(
      'Only team members',
    )

    await page.getByRole('button', { name: 'Delete team' }).click()
    const confirm = page.getByRole('dialog', { name: 'Delete Studio?' })
    await expect(confirm.getByRole('button', { name: 'Delete team' })).toBeDisabled()
    await confirm.getByRole('textbox').fill('Studio')
    await confirm.getByRole('button', { name: 'Delete team' }).click()
    await expect(page).toHaveURL(/#\/recents$/)
    await expect(
      page.getByRole('navigation', { name: 'Team' }).getByText('Acme Labs'),
    ).toBeVisible()
  })

  test('account menu: switch team, log out, sign back in where you were', async ({ page }) => {
    await openFixture(page, '/team/members')
    await page.getByRole('button', { name: 'Account menu: ceyhun cakir' }).click()
    await page.getByRole('menuitem', { name: 'Acme Labs' }).click()
    await expect(page.getByRole('heading', { name: 'Acme Labs settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Account menu: ceyhun cakir' }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/#\/auth\/sign-in$/)
    await page.getByLabel('Email').fill('ceyhun@example.com')
    await page.getByLabel('Password', { exact: true }).fill('correct horse')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    // Back where the session ended.
    await expect(page).toHaveURL(/#\/team\/members$/)
    await expect(page.getByRole('button', { name: 'Account menu: ceyhun cakir' })).toBeVisible()
  })

  test('sign-in validates fields; register → verify signs the new user in', async ({ page }) => {
    await openFixture(page, '/auth/sign-in')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Enter a valid email address.')).toBeVisible()
    await expect(page.getByText('Enter your password.')).toBeVisible()
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.getByLabel('Full name').fill('Defne Aydın')
    await page.getByLabel('Work email').fill('defne@example.com')
    await page.getByLabel('Password', { exact: true }).fill('barenpad26x')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByText(/accept the Terms/)).toBeVisible()
    await page.getByText('I agree to the Terms').click()
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page).toHaveURL(/#\/auth\/verify$/)
    await expect(page.getByText(/code to defne@example.com/)).toBeVisible()
    // Pasting the whole code fills every cell and submits.
    await page.getByLabel('Verification code').fill('482703')
    await expect(page).toHaveURL(/#\/recents$/)
    await expect(page.getByRole('button', { name: 'Account menu: Defne Aydın' })).toBeVisible()
  })

  test('sign in has no social buttons; forgot → reset signs in with the new password', async ({
    page,
  }) => {
    await openFixture(page, '/recents')
    await page.getByRole('button', { name: 'Account menu: ceyhun cakir' }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/#\/auth\/sign-in$/)
    // Email + password only.
    await expect(page.getByText(/Google|GitHub|or with email/)).toHaveCount(0)

    await page.getByLabel('Email').fill('ceyhun@example.com')
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page).toHaveURL(/#\/auth\/forgot$/)
    await expect(page).toHaveTitle(/^Forgot password/)
    // The address typed on sign-in comes along.
    await expect(page.getByLabel('Email')).toHaveValue('ceyhun@example.com')
    await page.getByRole('button', { name: 'Send reset code' }).click()

    await expect(page).toHaveURL(/#\/auth\/reset$/)
    await expect(page.getByText(/code to ceyhun@example.com/)).toBeVisible()
    await expect(page.getByText(/Resend in 0:(29|30)/)).toBeVisible()
    await page.getByRole('button', { name: 'Reset password' }).click()
    await expect(page.getByText('Enter the 6-digit code.')).toBeVisible()
    await page.getByLabel('Reset code').fill('482 719')
    await expect(page.getByLabel('New password', { exact: true })).toBeFocused()
    await page.keyboard.type('short')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Use at least 8 characters, including a number.')).toBeVisible()
    await page.getByLabel('New password', { exact: true }).fill('n3w-passw0rd')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#\/recents$/)
    await expect(page.getByText('Password changed. Other devices were signed out.')).toBeVisible()

    // The new password is the one that works now.
    await page.getByRole('button', { name: 'Account menu: ceyhun cakir' }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await expect(page.getByLabel('Email')).toHaveValue('ceyhun@example.com')
    await page.getByLabel('Password', { exact: true }).fill('old password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Wrong email or password.')).toBeVisible()
    await page.getByLabel('Password', { exact: true }).fill('n3w-passw0rd')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/#\/recents$/)
  })

  test('forgot password: back to sign in, and a direct visit to reset asks for the email', async ({
    page,
  }) => {
    await page.clock.setFixedTime(FIXED_NOW)
    await page.goto('/#/auth/reset')
    await expect(page).toHaveURL(/#\/auth\/forgot$/)
    await page.getByRole('button', { name: 'Send reset code' }).click()
    await expect(page.getByText('Enter a valid email address.')).toBeVisible()
    await page.getByLabel('Email').fill('someone@example.com')
    await page.getByRole('button', { name: 'Back to sign in' }).click()
    await expect(page).toHaveURL(/#\/auth\/sign-in$/)
    await expect(page.getByLabel('Email')).toHaveValue('someone@example.com')
  })

  test('update ready: card, Help dot and menu item; Later hides it, Restart installs', async ({
    page,
  }) => {
    await openScreen(page, '/recents', '&updates=ready')
    const card = page.locator('[data-update-notice="ready"]')
    await expect(card).toContainText('Version 0.2.0 is ready')
    const help = page.locator('[data-menubar-item]', { hasText: 'Help' })
    const dot = () =>
      help.evaluate((el) => getComputedStyle(el, '::after').getPropertyValue('content'))
    expect(await dot()).not.toBe('none')

    await card.getByRole('button', { name: 'Later' }).click()
    await expect(card).toHaveCount(0)
    // Still offered in the Help menu (and the dot stays) until the restart.
    expect(await dot()).not.toBe('none')
    await help.click()
    const item = page.getByRole('menuitem', { name: 'Restart to Update (0.2.0)…' })
    await expect(item).toBeVisible()
    await item.click()
    expect(await hook<number>(page, 'h.updateInstalls()')).toBe(1)

    // "Later" lasts until the next launch.
    await page.reload()
    await page.getByRole('button', { name: 'Restart' }).click()
    expect(await hook<number>(page, 'h.updateInstalls()')).toBe(1)
  })

  test('Help → Check for Updates reports checking, up to date, progress and errors', async ({
    page,
  }) => {
    await openFixture(page, '/recents')
    await page.locator('[data-menubar-item]', { hasText: 'Help' }).click()
    const item = page.getByRole('menuitem', { name: /Check for Updates…/ })
    // The version is shown next to the item.
    await expect(item).toContainText('v0.1.0')
    await item.click()
    await expect(page.locator('[data-update-notice="checking"]')).toBeVisible()
    const upToDate = page.locator('[data-update-notice="upToDate"]')
    await expect(upToDate).toContainText('Baren 0.1.0 is the latest version.')

    // A newer version shows up and downloads: the card follows the progress.
    await hook(page, "h.setUpdateStatus({ state: 'downloading', version: '0.2.0', progress: 42 })")
    const downloading = page.locator('[data-update-notice="downloading"]')
    await expect(downloading).toContainText('Downloading version 0.2.0')
    await expect(downloading.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    await page.locator('[data-menubar-item]', { hasText: 'Help' }).click()
    await expect(page.getByRole('menuitem', { name: 'Downloading Update… 42%' })).toBeDisabled()
    await page.keyboard.press('Escape')

    await hook(
      page,
      "h.setUpdateStatus({ state: 'error', version: '0.2.0', error: 'net::ERR_CONNECTION_REFUSED' })",
    )
    const failed = page.locator('[data-update-notice="error"]')
    await expect(failed).toContainText("Couldn't update to 0.2.0")
    await expect(failed).toContainText('net::ERR_CONNECTION_REFUSED')
    await failed.getByRole('button', { name: 'Close' }).click()
    await expect(failed).toHaveCount(0)

    // A failed background check (nobody asked) stays quiet.
    await hook(page, "h.setUpdateStatus({ state: 'checking' })")
    await hook(page, "h.setUpdateStatus({ state: 'error', error: 'offline' })")
    await expect(page.locator('[data-update-notice]')).toHaveCount(0)
  })

  test('theme: the account menu switches <html data-theme>; preferences change the password', async ({
    page,
  }) => {
    await openFixture(page, '/recents')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-theme', 'light')
    await page.getByRole('button', { name: 'Account menu: ceyhun cakir' }).click()
    const theme = page.getByRole('radiogroup', { name: 'Theme' })
    await expect(theme.getByRole('radio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await theme.getByRole('radio', { name: 'Dark' }).click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await theme.getByRole('radio', { name: 'System' }).click()
    await expect(html).toHaveAttribute('data-theme', 'light')
    await hook(page, 'h.setSystemDark(true)')
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await hook(page, 'h.setSystemDark(false)')
    await expect(html).toHaveAttribute('data-theme', 'light')

    await page.getByRole('menuitem', { name: /Preferences/ }).click()
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await expect(prefs.getByRole('radio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(prefs.getByText('Baren 0.1.0')).toBeVisible()
    await prefs.getByRole('button', { name: 'Change password…' }).click()
    const change = page.getByRole('dialog', { name: 'Change password' })
    await change.getByLabel('New password', { exact: true }).fill('n3w-passw0rd')
    await change.getByRole('button', { name: 'Change password' }).click()
    await expect(change.getByText('Enter your current password.')).toBeVisible()
    await change.getByLabel('Current password', { exact: true }).fill('correct horse')
    await change.getByRole('button', { name: 'Change password' }).click()
    await expect(
      page.getByText('Password changed. Your other devices were signed out.'),
    ).toBeVisible()
    await expect(change).toHaveCount(0)
  })

  test('continue in browser opens the device page and can be cancelled', async ({ page }) => {
    await openFixture(page, '/auth/sign-in')
    await page.getByRole('button', { name: 'Sign in with browser' }).click()
    await expect(page.getByText('KQ7-4XM')).toBeVisible()
    expect(await hook<string[]>(page, 'h.openedUrls()')).toEqual([
      expect.stringContaining('/device?code=KQ7-4XM'),
    ])
    await page.getByRole('button', { name: 'Open browser again' }).click()
    expect(await hook<string[]>(page, 'h.openedUrls()')).toHaveLength(2)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/#\/auth\/sign-in$/)
  })

  test('an invite deep link previews the team and joins it', async ({ page }) => {
    await openFixture(page, '/recents')
    await hook(page, "h.emitDeepLink('baren://invite/tok-inv-mert')")
    await expect(page.getByRole('heading', { name: "Join ceyhun's Team" })).toBeVisible()
    await expect(page.getByText(/ceyhun cakir invited you to collaborate as viewer/)).toBeVisible()
    await page.getByRole('button', { name: 'Accept invite' }).click()
    await expect(page).toHaveURL(/#\/team\/members$/)
    await expect(page.getByText("You're already a member of ceyhun's Team")).toBeVisible()
    await hook(page, "h.emitDeepLink('baren://invite/unknown-token')")
    await expect(page.getByRole('heading', { name: 'This invite link is not valid' })).toBeVisible()
  })
})

test.describe('without the design fixture', () => {
  test('signed-out users land on sign in; offline mode opens local files and is remembered', async ({
    page,
  }) => {
    let ready = false
    await page.exposeFunction('__ready', () => {
      ready = true
    })
    await page.addInitScript('window.addEventListener("baren:ready", () => window.__ready())')
    await page.goto('/')
    await expect(page).toHaveURL(/#\/auth\/sign-in$/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await expect.poll(() => ready).toBe(true)
    await page.getByRole('button', { name: 'Continue offline' }).click()
    await expect(page).toHaveURL(/#\/recents$/)
    await expect(page.getByRole('button', { name: /^acme dashboard/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in to collaborate' })).toBeVisible()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    // A window opened without a route resumes on the last screen.
    await page.goto('/')
    await expect(page).toHaveURL(/#\/files$/)
  })

  test('the Recents grid is virtualized', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Continue offline' }).click()
    await expect(page.getByRole('button', { name: /^acme dashboard/ })).toBeVisible()
    await hook(page, "h.createFiles(2000, 'Bulk')")
    await expect(page.getByRole('button', { name: /^Bulk / }).first()).toBeVisible()
    // 2,008 files, but only the rows near the viewport are in the DOM.
    expect(await page.locator('[data-file-id]').count()).toBeLessThan(60)
    await page.getByTestId('file-grid').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(page.getByRole('button', { name: /^Scratchpad/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Bulk / }).last()).toBeInViewport()
    expect(await page.locator('[data-file-id]').count()).toBeLessThan(60)
  })
})

/* ------------------------------------------------------------------ real server */

/**
 * Browser mode against a real `baren-server` (no fixture). Run it with
 * `MAIL_TRANSPORT=file:<dir>` and start the tests with `BAREN_E2E_MAIL_DIR=<dir>` and
 * `VITE_SERVER_URL=<server>` (the Vite dev server bakes the URL in), e.g.:
 *
 *   MAIL_TRANSPORT=file:/tmp/mail BIND=127.0.0.1:8899 DATABASE_URL=sqlite:///tmp/e2e.db \
 *     baren-server &
 *   BAREN_E2E_MAIL_DIR=/tmp/mail VITE_SERVER_URL=http://127.0.0.1:8899 \
 *     pnpm test:visual --grep "real server"
 */
const E2E_MAIL_DIR = process.env['BAREN_E2E_MAIL_DIR']

interface MailRecord {
  kind: string
  to: string
  code?: string | null
  url?: string | null
}

/** The newest message of `kind` to `to` written after `after` (ms) by the file transport. */
async function mailed(kind: string, to: string, after: number): Promise<MailRecord> {
  let found: MailRecord | null = null
  await expect
    .poll(
      () => {
        for (const name of readdirSync(E2E_MAIL_DIR!).sort().reverse()) {
          if (!name.endsWith('.json') || Number.parseInt(name, 10) < after) continue
          const mail = JSON.parse(readFileSync(resolve(E2E_MAIL_DIR!, name), 'utf8')) as MailRecord
          if (mail.kind === kind && mail.to.includes(to)) {
            found = mail
            return true
          }
        }
        return false
      },
      { message: `${kind} mail to ${to}`, timeout: 10_000 },
    )
    .toBe(true)
  return found!
}

async function mailedCode(kind: string, to: string, after: number): Promise<string> {
  const mail = await mailed(kind, to, after)
  expect(mail.code, `${kind} code`).toMatch(/\d/)
  return mail.code!
}

test.describe('against a real server', () => {
  test.skip(!E2E_MAIL_DIR, 'needs BAREN_E2E_MAIL_DIR + VITE_SERVER_URL (see above)')

  test('register → verify → sign out → forgot → reset → sign in', async ({ page }) => {
    const email = `e2e-${Date.now()}@example.com`
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    await expect(page).toHaveURL(/#\/auth\/sign-in$/)
    await expect(page.getByText(/Google|GitHub|or with email/)).toHaveCount(0)

    // Register.
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.getByLabel('Full name').fill('Eda Ersoy')
    await page.getByLabel('Work email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill('first-passw0rd')
    await page.getByText('I agree to the Terms').click()
    let sent = Date.now() - 1000
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page).toHaveURL(/#\/auth\/verify$/)
    // MAIL_TRANSPORT=file is not real delivery: providers() says email=false.
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible()
    await expect(page.getByText(/Ask the server admin/)).toBeVisible()

    // Verify with the mailed code.
    await page
      .getByLabel('Verification code')
      .fill(await mailedCode('verification_code', email, sent))
    await expect(page).toHaveURL(/#\/recents$/)
    await expect(page.getByRole('button', { name: 'Account menu: Eda Ersoy' })).toBeVisible()

    // Sign out.
    await page.getByRole('button', { name: 'Account menu: Eda Ersoy' }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/#\/auth\/sign-in$/)

    // Forgot → reset.
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page).toHaveURL(/#\/auth\/forgot$/)
    sent = Date.now() - 1000
    await page.getByRole('button', { name: 'Send reset code' }).click()
    await expect(page).toHaveURL(/#\/auth\/reset$/)
    const code = await mailedCode('password_reset', email, sent)
    // A wrong code first: the server rejects it on the code field.
    const wrong = code === '000000' ? '111111' : '000000'
    await page.getByLabel('Reset code').fill(wrong)
    await page.getByLabel('New password', { exact: true }).fill('second-passw0rd')
    await page.getByRole('button', { name: 'Reset password' }).click()
    await expect(page.getByText(/That code isn't right/)).toBeVisible()
    await page.getByLabel('Reset code').fill(code)
    await page.getByRole('button', { name: 'Reset password' }).click()
    await expect(page).toHaveURL(/#\/recents$/)
    await expect(page.getByRole('button', { name: 'Account menu: Eda Ersoy' })).toBeVisible()

    // Sign in with the new password (the old one no longer works).
    await page.getByRole('button', { name: 'Account menu: Eda Ersoy' }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/#\/auth\/sign-in$/)
    await expect(page.getByLabel('Email')).toHaveValue(email)
    await page.getByLabel('Password', { exact: true }).fill('first-passw0rd')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Wrong email or password.')).toBeVisible()
    await page.getByLabel('Password', { exact: true }).fill('second-passw0rd')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/#\/recents$/)
    await expect(page.getByRole('button', { name: 'Account menu: Eda Ersoy' })).toBeVisible()
    expect(errors, 'page errors').toEqual([])
  })

  test('team invite email + resend, and change password', async ({ page }) => {
    const email = `e2e-team-${Date.now()}@example.com`
    const invitee = `guest-${Date.now()}@example.com`
    await page.goto('/')
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.getByLabel('Full name').fill('Ozan Kaya')
    await page.getByLabel('Work email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill('first-passw0rd')
    await page.getByText('I agree to the Terms').click()
    let sent = Date.now() - 1000
    await page.getByRole('button', { name: 'Create account' }).click()
    await page
      .getByLabel('Verification code')
      .fill(await mailedCode('verification_code', email, sent))
    await expect(page).toHaveURL(/#\/recents$/)

    // Invite by email: the server mails it even though it only writes files here; the app
    // says it does not send email (providers().email is false) and offers the link.
    await page.getByRole('button', { name: 'Invite members' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Invite members' })
    await dialog.getByLabel('Email (optional)').fill(invitee)
    sent = Date.now() - 1000
    await dialog.getByRole('button', { name: 'Create invite link' }).click()
    await expect(dialog.getByText(`Share this link with ${invitee}`)).toBeVisible()
    const firstUrl = await dialog.getByLabel('Invite link').inputValue()
    expect(firstUrl).toMatch(/\/i\//)
    expect((await mailed('team_invite', invitee, sent)).url).toBe(firstUrl)
    await dialog.getByRole('button', { name: 'Done' }).click()

    await page.goto('/#/team/members')
    const row = page.getByRole('row').filter({ hasText: invitee })
    await expect(row).toBeVisible()
    sent = Date.now()
    await row.getByRole('button', { name: 'Resend invite' }).click()
    await expect(page.getByText(/New invite link (copied|created)/)).toBeVisible()
    // Mailed again with a rotated link.
    const resent = await mailed('team_invite', invitee, sent)
    expect(resent.url).toMatch(/\/i\//)
    expect(resent.url).not.toBe(firstUrl)

    // Change password: the current one is checked by the server.
    await page.keyboard.press('Control+,')
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await prefs.getByRole('button', { name: 'Change password…' }).click()
    const change = page.getByRole('dialog', { name: 'Change password' })
    await change.getByLabel('Current password', { exact: true }).fill('not-my-passw0rd')
    await change.getByLabel('New password', { exact: true }).fill('second-passw0rd')
    await change.getByRole('button', { name: 'Change password' }).click()
    await expect(change.getByText("That's not your current password.")).toBeVisible()
    await change.getByLabel('Current password', { exact: true }).fill('first-passw0rd')
    await change.getByRole('button', { name: 'Change password' }).click()
    await expect(
      page.getByText('Password changed. Your other devices were signed out.'),
    ).toBeVisible()
    // Still signed in here.
    await expect(page.getByRole('button', { name: 'Account menu: Ozan Kaya' })).toBeVisible()
  })
})
