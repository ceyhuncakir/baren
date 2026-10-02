import type { BrowserWindowConstructorOptions } from 'electron'
import { MIN_WINDOW_SIZE, type Rect } from './windowState'

/**
 * Light `--color-surface`: painted before the first frame so there is no white flash. The
 * window manager passes the resolved theme's surface instead (`theme/theme.ts`).
 */
export const WINDOW_BACKGROUND = '#F7F7F7'
/** Height of the renderer's title bar ("Title bar" in the artboards, 36px). */
export const TITLE_BAR_HEIGHT = 36
/** macOS traffic lights (~14px tall) vertically centred in the title bar. */
export const TRAFFIC_LIGHT_POSITION = { x: 14, y: (TITLE_BAR_HEIGHT - 14) / 2 }

export interface WindowOptionsInput {
  platform: string
  bounds: Rect
  preloadPath: string
  /** Window/taskbar icon (Linux dev builds; packaged apps use the .desktop icon). */
  icon?: string
  /** Surface colour of the resolved theme (default: light). */
  backgroundColor?: string
  /** Appended to the renderer's `process.argv` (the preload reads the theme from it). */
  additionalArguments?: string[]
}

/**
 * The renderer draws its own title bar, menus and window controls
 * (artboards 09–13): frameless on Linux/Windows; on macOS the native frame
 * stays (rounded corners, shadow, resize) with hidden-inset traffic lights.
 */
export function windowOptions(input: WindowOptionsInput): BrowserWindowConstructorOptions {
  const isMac = input.platform === 'darwin'
  return {
    ...input.bounds,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: 'Baren',
    backgroundColor: input.backgroundColor ?? WINDOW_BACKGROUND,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: TRAFFIC_LIGHT_POSITION }
      : { frame: false }),
    ...(input.icon && input.platform === 'linux' ? { icon: input.icon } : {}),
    webPreferences: {
      preload: input.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      // Produce V8 code cache on first run so later cold starts skip parsing/compiling.
      v8CacheOptions: 'bypassHeatCheck',
      ...(input.additionalArguments?.length
        ? { additionalArguments: [...input.additionalArguments] }
        : {}),
    },
  }
}
