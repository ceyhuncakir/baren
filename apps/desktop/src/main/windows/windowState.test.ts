import { describe, expect, it } from 'vitest'
import { matchAppShortcut, type KeyInput } from './shortcuts'
import { windowOptions, WINDOW_BACKGROUND } from './windowOptions'
import {
  CASCADE_OFFSET,
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  cascadeBounds,
  parseWindowState,
  restoreWindowState,
  type Rect,
} from './windowState'

const primary: Rect = { x: 0, y: 32, width: 1920, height: 1048 }
const secondary: Rect = { x: 1920, y: 0, width: 2560, height: 1440 }

describe('parseWindowState', () => {
  it('accepts valid state and rounds coordinates', () => {
    expect(
      parseWindowState({ bounds: { x: 10.4, y: 20.6, width: 1200, height: 800 }, maximized: true }),
    ).toEqual({
      bounds: { x: 10, y: 21, width: 1200, height: 800 },
      maximized: true,
    })
  })

  it.each([
    null,
    'x',
    {},
    { bounds: { x: 0, y: 0, width: 0, height: 10 } },
    { bounds: { x: 0, y: 0, width: Number.NaN, height: 10 } },
    { bounds: { x: '0', y: 0, width: 10, height: 10 } },
  ])('rejects malformed state %#', (value) => {
    expect(parseWindowState(value)).toBeNull()
  })

  it('treats a missing maximized flag as false', () => {
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: 1100, height: 800 } })?.maximized).toBe(
      false,
    )
  })
})

describe('restoreWindowState', () => {
  it('centres the default size on the primary display without saved state', () => {
    const { bounds, maximized } = restoreWindowState(null, [primary], primary)
    expect(bounds).toEqual({
      x: (1920 - DEFAULT_WINDOW_SIZE.width) / 2,
      y: 32 + (1048 - DEFAULT_WINDOW_SIZE.height) / 2,
      ...DEFAULT_WINDOW_SIZE,
    })
    expect(maximized).toBe(false)
  })

  it('restores saved bounds on the display they were on', () => {
    const saved = { bounds: { x: 2000, y: 100, width: 1300, height: 900 }, maximized: true }
    expect(restoreWindowState(saved, [primary, secondary], primary)).toEqual(saved)
  })

  it('falls back to the primary display when the saved display is gone', () => {
    const saved = { bounds: { x: 2000, y: 100, width: 1300, height: 900 }, maximized: true }
    const restored = restoreWindowState(saved, [primary], primary)
    expect(restored.bounds.x).toBeLessThan(1920)
    expect(restored.maximized).toBe(true)
  })

  it('pulls partially off-screen windows back inside the work area', () => {
    const saved = { bounds: { x: -400, y: 500, width: 1400, height: 900 }, maximized: false }
    const { bounds } = restoreWindowState(saved, [primary], primary)
    expect(bounds.x).toBe(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(32 + 1048)
  })

  it('never shrinks below the minimum size, even on small screens', () => {
    const small: Rect = { x: 0, y: 0, width: 1280, height: 720 }
    const { bounds } = restoreWindowState(null, [small], small)
    expect(bounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    const tiny: Rect = { x: 0, y: 0, width: 800, height: 600 }
    const t = restoreWindowState(null, [tiny], tiny).bounds
    expect(t.width).toBe(MIN_WINDOW_SIZE.width)
    expect(t.height).toBe(MIN_WINDOW_SIZE.height)
  })
})

describe('cascadeBounds', () => {
  it('offsets new windows from the source window', () => {
    const from = { x: 100, y: 100, width: 1200, height: 800 }
    expect(cascadeBounds(from, primary)).toEqual({
      x: 100 + CASCADE_OFFSET,
      y: 100 + CASCADE_OFFSET,
      width: 1200,
      height: 800,
    })
  })

  it('wraps to the top-left when the next position would overflow', () => {
    const from = { x: 700, y: 300, width: 1200, height: 800 }
    const next = cascadeBounds(from, primary)
    expect(next.x).toBe(primary.x + CASCADE_OFFSET)
    expect(next.y).toBe(primary.y + CASCADE_OFFSET)
  })
})

describe('windowOptions', () => {
  const base = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, preloadPath: '/p.js' }

  it('paints the resolved theme and hands the preload its theme argument', () => {
    const o = windowOptions({
      ...base,
      platform: 'linux',
      backgroundColor: '#202020',
      additionalArguments: ['--baren-theme=dark'],
    })
    expect(o.backgroundColor).toBe('#202020')
    expect(o.webPreferences?.additionalArguments).toEqual(['--baren-theme=dark'])
    expect(windowOptions({ ...base, platform: 'linux' }).webPreferences).not.toHaveProperty(
      'additionalArguments',
    )
  })

  it('is frameless on Linux and Windows', () => {
    for (const platform of ['linux', 'win32']) {
      const o = windowOptions({ ...base, platform })
      expect(o.frame).toBe(false)
      expect(o.titleBarStyle).toBeUndefined()
    }
  })

  it('uses hidden-inset traffic lights on macOS', () => {
    const o = windowOptions({ ...base, platform: 'darwin', icon: '/i.png' })
    expect(o.frame).toBeUndefined()
    expect(o.titleBarStyle).toBe('hiddenInset')
    expect(o.trafficLightPosition).toEqual({ x: 14, y: 11 })
    expect(o.icon).toBeUndefined()
  })

  it('is secure, flash-free and respects the minimum size', () => {
    const o = windowOptions({ ...base, platform: 'linux', icon: '/i.png' })
    expect(o).toMatchObject({
      show: false,
      backgroundColor: WINDOW_BACKGROUND,
      minWidth: 1024,
      minHeight: 700,
      icon: '/i.png',
    })
    expect(o.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      preload: '/p.js',
    })
  })
})

describe('matchAppShortcut', () => {
  const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
    type: 'keyDown',
    key: k,
    control: false,
    shift: false,
    alt: false,
    meta: false,
    ...mods,
  })

  it('maps the shortcuts shown in the HTML menus', () => {
    expect(matchAppShortcut(key('N', { control: true, shift: true }))).toBe('newWindow')
    expect(matchAppShortcut(key('q', { control: true }))).toBe('quit')
    expect(matchAppShortcut(key('r', { control: true }))).toBe('reload')
    expect(matchAppShortcut(key('R', { control: true, shift: true }))).toBe('forceReload')
    expect(matchAppShortcut(key('I', { control: true, shift: true }))).toBe('toggleDevTools')
    expect(matchAppShortcut(key('F11'))).toBe('toggleFullScreen')
    expect(matchAppShortcut(key('m', { control: true }))).toBe('minimize')
    expect(matchAppShortcut(key('w', { control: true }))).toBe('closeWindow')
  })

  it('leaves everything else to the page', () => {
    expect(matchAppShortcut(key('z', { control: true }))).toBeNull()
    expect(matchAppShortcut(key('n', { control: true }))).toBeNull()
    expect(matchAppShortcut(key('q'))).toBeNull()
    expect(matchAppShortcut(key('q', { control: true, alt: true }))).toBeNull()
    expect(matchAppShortcut(key('r', { control: true, type: 'keyUp' }))).toBeNull()
    expect(matchAppShortcut(key('w', { control: true, isAutoRepeat: true }))).toBeNull()
  })
})
