/**
 * The shared off-screen render window (contract §4.7): screenshots, image exports, browser-
 * computed styles, font probing and image transcoding. One hidden OSR window loading
 * `#/agent-render`, created lazily, destroyed after 60 s idle, processing one job at a time.
 *
 * Capture flow: the host builds a `RenderJob`; the render page builds the stage and answers its
 * size and effective scale (`stage_prepare`); main sizes the window to the output, waits for a
 * paint, captures it and encodes it; `stage_clear` resets the page.
 *
 * Electron-free: the window comes from the injected factory (controller.ts).
 */
import type { RenderJob } from '../../renderer/types/bridge'
import type { Logger } from '../log'
import { ToolError } from './format'
import type { AgentRpc, RpcTarget } from './ipc'

export interface CapturedImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(size: { width: number; height: number }): CapturedImage
  toPNG(): Uint8Array
  toJPEG(quality: number): Uint8Array
}

export interface RenderWindow extends RpcTarget {
  /** Resolves when the page has loaded. */
  readonly loaded: Promise<void>
  setContentSize(width: number, height: number): void
  /** Force a frame and resolve on the next `paint` (or after `timeoutMs`). */
  nextPaint(timeoutMs: number): Promise<void>
  capture(rect: { x: number; y: number; width: number; height: number }): Promise<CapturedImage>
  printToPdf(size: { widthPx: number; heightPx: number }): Promise<Uint8Array>
  /**
   * One throw-away capture right after the page is ready: the first capture of a new off-screen
   * window can come back empty or fail.
   */
  warmUp?(): Promise<void>
  destroy(): void
}

export interface StagePrepared {
  width: number
  height: number
  scale: number
  outWidth: number
  outHeight: number
}

export type ImageFormat = 'jpeg' | 'png' | 'webp'

export interface CaptureOptions {
  scale: number
  maxSide: number
  maxPixels: number
  transparent: boolean
  format: ImageFormat
  quality?: number
  signal?: AbortSignal
  timeoutMs: number
}

export interface CaptureResult {
  bytes: Uint8Array
  mime: string
  width: number
  height: number
  /** Effective scale (may be below the requested one when capped). */
  scale: number
  /** The node's CSS size in the stage. */
  cssWidth: number
  cssHeight: number
}

export const SCREENSHOT_LIMITS = { maxSide: 1568, maxPixels: 1_150_000 } as const
export const EXPORT_MAX_SIDE = 8192

/** `s = min(scale, maxSide / max(w, h), sqrt(maxPixels / (w × h)))` (also computed by the page). */
export function effectiveScale(
  width: number,
  height: number,
  scale: number,
  maxSide: number,
  maxPixels: number,
): number {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  return Math.min(scale, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)))
}

function isPrepared(value: unknown): value is StagePrepared {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return ['width', 'height', 'scale', 'outWidth', 'outHeight'].every(
    (k) => typeof v[k] === 'number' && Number.isFinite(v[k]),
  )
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === 'object' && value !== null) {
    const bytes = (value as { bytes?: unknown }).bytes
    if (bytes instanceof Uint8Array) return bytes
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
    if (typeof bytes === 'string') return new Uint8Array(Buffer.from(bytes, 'base64'))
  }
  return null
}

export interface RenderServiceOptions {
  create(): RenderWindow
  rpc: AgentRpc
  log?: Logger
  idleMs?: number
  /** Deadline of stage and probe requests (BAREN_MCP_TOOL_TIMEOUT_MS overrides). */
  timeoutMs?: number
  /** How long to wait for the render page to answer its first request. */
  readyTimeoutMs?: number
}

export class RenderService {
  private window: RenderWindow | null = null
  private ready: Promise<RenderWindow> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private busy = 0
  private disposed = false

  constructor(private readonly options: RenderServiceOptions) {}

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  /** The render window is gone (crash, destroy): the next job creates a new one. */
  windowGone(webContentsId: number): void {
    if (this.window && this.window.webContentsId === webContentsId) {
      this.window = null
      this.ready = null
    }
  }

  private async open(): Promise<RenderWindow> {
    if (this.window && !this.window.isDestroyed() && this.ready) return this.ready
    const win = this.options.create()
    this.window = win
    this.ready = (async () => {
      await win.loaded
      // The page registers its listener asynchronously: probe with the idempotent stage_clear.
      const until = Date.now() + (this.options.readyTimeoutMs ?? 15_000)
      for (;;) {
        try {
          await this.options.rpc.request(win, {
            fileId: null,
            tool: 'stage_clear',
            args: {},
            timeoutMs: 400,
          })
          await win.warmUp?.().catch(() => undefined)
          return win
        } catch (error) {
          if (win.isDestroyed()) throw new ToolError('host_unavailable', 'The render window closed')
          if (Date.now() > until) {
            throw new ToolError(
              'host_unavailable',
              `The render window did not start (${error instanceof Error ? error.message : String(error)})`,
            )
          }
        }
      }
    })()
    this.ready.catch(() => {
      if (this.window === win) {
        this.window = null
        this.ready = null
        if (!win.isDestroyed()) win.destroy()
      }
    })
    return this.ready
  }

  /** Run `fn` with the render window, one job at a time (FIFO). */
  run<T>(fn: (win: RenderWindow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new ToolError('cancelled', 'Baren is quitting'))
    this.busy++
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const task = async (): Promise<T> => {
      if (signal?.aborted) throw new ToolError('cancelled', 'The request was cancelled')
      const win = await this.open()
      return fn(win)
    }
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    void this.queue.then(() => {
      this.busy--
      if (this.busy === 0) this.scheduleIdle()
    })
    return result
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.busy === 0) this.close()
    }, this.options.idleMs ?? 60_000)
    this.idleTimer.unref?.()
  }

  private request<T = unknown>(
    win: RenderWindow,
    tool: 'stage_prepare' | 'stage_styles' | 'stage_clear' | 'fonts_probe' | 'image_transcode',
    args: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    return this.options.rpc
      .request(win, {
        fileId: null,
        tool,
        args,
        timeoutMs: timeoutMs ?? this.options.timeoutMs ?? 30_000,
        ...(signal ? { signal } : {}),
      })
      .then((r) => r.result as T)
  }

  /** Prepare a stage, capture it and encode it (screenshots and image exports). */
  capture(job: RenderJob, opts: CaptureOptions): Promise<CaptureResult> {
    return this.run(async (win) => {
      try {
        const prepared = await this.request(
          win,
          'stage_prepare',
          {
            job,
            scale: opts.scale,
            maxSide: opts.maxSide,
            maxPixels: Number.isFinite(opts.maxPixels) ? opts.maxPixels : null,
            transparent: opts.transparent,
          },
          opts.signal,
          opts.timeoutMs,
        )
        if (!isPrepared(prepared))
          throw new ToolError('internal', 'The render page gave no stage size')
        const outWidth = Math.max(1, Math.ceil(prepared.outWidth))
        const outHeight = Math.max(1, Math.ceil(prepared.outHeight))
        win.setContentSize(outWidth, outHeight)
        await win.nextPaint(1000)
        let image = await win.capture({ x: 0, y: 0, width: outWidth, height: outHeight })
        if (image.isEmpty()) {
          // One more frame: the first paint after a resize can arrive before the new size.
          await win.nextPaint(1000)
          image = await win.capture({ x: 0, y: 0, width: outWidth, height: outHeight })
        }
        if (image.isEmpty()) throw new ToolError('internal', 'The capture was empty')
        const size = image.getSize()
        if (size.width !== outWidth || size.height !== outHeight) {
          image = image.resize({ width: outWidth, height: outHeight })
        }
        let bytes: Uint8Array
        let mime: string
        if (opts.format === 'jpeg') {
          bytes = image.toJPEG(opts.quality ?? 90)
          mime = 'image/jpeg'
        } else if (opts.format === 'png') {
          bytes = image.toPNG()
          mime = 'image/png'
        } else {
          const res = await this.request(
            win,
            'image_transcode',
            { png: image.toPNG(), to: 'webp', quality: (opts.quality ?? 92) / 100 },
            opts.signal,
            opts.timeoutMs,
          )
          const webp = toBytes(res)
          if (!webp) throw new ToolError('internal', 'WebP encoding failed')
          bytes = webp
          mime = 'image/webp'
        }
        return {
          bytes,
          mime,
          width: outWidth,
          height: outHeight,
          scale: prepared.scale,
          cssWidth: prepared.width,
          cssHeight: prepared.height,
        }
      } finally {
        await this.request(win, 'stage_clear', {}, undefined, 5_000).catch(() => undefined)
      }
    }, opts.signal)
  }

  /** Prepare a stage at scale 1 and print it to PDF (SHOULD; `unsupported` when it fails). */
  pdf(
    job: RenderJob,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<{
    bytes: Uint8Array
    width: number
    height: number
  }> {
    return this.run(async (win) => {
      try {
        const prepared = await this.request(
          win,
          'stage_prepare',
          { job, scale: 1, maxSide: EXPORT_MAX_SIDE, maxPixels: null, transparent: true },
          opts.signal,
          opts.timeoutMs,
        )
        if (!isPrepared(prepared))
          throw new ToolError('internal', 'The render page gave no stage size')
        const width = Math.max(1, Math.ceil(prepared.width))
        const height = Math.max(1, Math.ceil(prepared.height))
        win.setContentSize(width, height)
        await win.nextPaint(1000)
        try {
          const bytes = await win.printToPdf({ widthPx: width, heightPx: height })
          return { bytes, width, height }
        } catch (error) {
          throw new ToolError(
            'unsupported',
            `PDF export is not available here (${error instanceof Error ? error.message : String(error)})`,
          )
        }
      } finally {
        await this.request(win, 'stage_clear', {}, undefined, 5_000).catch(() => undefined)
      }
    }, opts.signal)
  }

  /** Browser-computed styles of `nodeIds` in the job's stage. */
  styles(job: RenderJob, nodeIds: readonly string[], signal?: AbortSignal): Promise<unknown> {
    return this.run((win) => this.request(win, 'stage_styles', { job, nodeIds }, signal), signal)
  }

  fonts(familyNames: readonly string[], signal?: AbortSignal): Promise<unknown> {
    return this.run((win) => this.request(win, 'fonts_probe', { familyNames }, signal), signal)
  }

  /** Re-encode image bytes (or an asset by hash) in the render page. */
  transcode(
    input: { hash: string } | { png: Uint8Array },
    to: ImageFormat,
    opts: { maxSide?: number; quality?: number; signal?: AbortSignal } = {},
  ): Promise<{ bytes: Uint8Array; width: number | null; height: number | null }> {
    return this.run(async (win) => {
      const res = await this.request<unknown>(
        win,
        'image_transcode',
        {
          ...input,
          to,
          ...(opts.maxSide !== undefined ? { maxSide: opts.maxSide } : {}),
          ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
        },
        opts.signal,
      )
      const bytes = toBytes(res)
      if (!bytes) throw new ToolError('internal', 'Image transcoding failed')
      const r = (typeof res === 'object' && res !== null ? res : {}) as Record<string, unknown>
      return {
        bytes,
        width: typeof r['width'] === 'number' ? r['width'] : null,
        height: typeof r['height'] === 'number' ? r['height'] : null,
      }
    }, opts.signal)
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const win = this.window
    this.window = null
    this.ready = null
    if (win && !win.isDestroyed()) {
      this.options.rpc.targetGone(win.webContentsId, 'The render window closed')
      win.destroy()
    }
  }

  dispose(): void {
    this.disposed = true
    this.close()
  }
}
