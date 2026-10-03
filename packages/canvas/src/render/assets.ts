import { rewriteAssetUrls } from '@baren/schema'
import type { AssetResolver } from '../types.ts'

/**
 * Neutral fill drawn instead of an image fill whose asset is missing (not downloaded yet,
 * or not stored at all). A CSS image, so `background-size`/`repeat` still apply.
 */
export const MISSING_FILL_CSS = 'linear-gradient(#E3E3E3, #E3E3E3)'
export const MISSING_FILL_COLOR = '#E3E3E3'

/**
 * Whether drawing an image from `url` into a canvas keeps it exportable: blob/data URLs
 * and same-origin URLs never taint; anything else (e.g. `baren-asset://` from the app's
 * `app://` origin) must be loaded through CORS first.
 */
export function isTaintFree(url: string): boolean {
  if (url.startsWith('blob:') || url.startsWith('data:')) return true
  try {
    return typeof location !== 'undefined' && new URL(url, location.href).origin === location.origin
  } catch {
    return false
  }
}

interface Entry {
  /** undefined while the resolver runs; null = no such asset. */
  url: string | null | undefined
  /** Callbacks waiting for the resolver. */
  waiters: ((url: string | null) => void)[] | null
  /** Loading `url` failed (an <img> error or a failed probe): treat as missing. */
  failed: boolean
  /** The URL loaded fine (existence probe). */
  exists: boolean
  probing: boolean
  /** Decoded copy that can be drawn into canvases without tainting them (thumbnails). */
  image: HTMLImageElement | null
  drawLoading: boolean
  /** A drawable copy cannot be had (CORS refused): thumbnails use the placeholder. */
  undrawable: boolean
}

interface SvgEntry {
  markup: string
  image: HTMLImageElement | null
  failed: boolean
}

/** Decoded SVG layer images kept for thumbnails (oldest dropped first). */
const MAX_SVG_IMAGES = 500

/** `svg:<length>:<FNV-1a>` — a short key for an SVG layer image (thumbnails wait on it). */
function svgKey(markup: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < markup.length; i++) {
    h ^= markup.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `svg:${markup.length}:${(h >>> 0).toString(36)}`
}

/**
 * Resolves asset ids (content hashes) to URLs through the host's resolver, once per id,
 * and remembers what is known about each asset: its URL, whether loading it failed, and a
 * decoded copy for LOD thumbnails. Changes (async resolution finished, a load failed or
 * succeeded after a probe, the host invalidated an id) are reported in batches through
 * `onChange`, so the scene can re-render exactly the nodes that reference those ids.
 *
 * Framework/bridge-agnostic: the resolver decides between `baren-asset://` URLs
 * (Electron's protocol handler) and blob URLs (browser mode).
 */
export class AssetUrlCache {
  private readonly entries = new Map<string, Entry>()
  private readonly svgs = new Map<string, SvgEntry>()
  private changed: Set<string> | null = null
  private inflight = 0

  constructor(
    private readonly resolver: AssetResolver | undefined,
    private readonly onChange: (ids: ReadonlySet<string>) => void = () => undefined,
  ) {}

  /** Resolutions and probes still running (part of the canvas' pending work). */
  get pending(): number {
    return this.inflight
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id)
    if (!e) {
      e = {
        url: undefined,
        waiters: null,
        failed: false,
        exists: false,
        probing: false,
        image: null,
        drawLoading: false,
        undrawable: false,
      }
      this.entries.set(id, e)
      this.start(id, e)
    }
    return e
  }

  private start(id: string, e: Entry): void {
    if (!this.resolver) {
      e.url = null
      return
    }
    let result: string | null | Promise<string | null>
    try {
      result = this.resolver(id)
    } catch {
      result = null
    }
    if (!(result instanceof Promise)) {
      e.url = result
      return
    }
    this.inflight++
    const settle = (url: string | null) => {
      this.inflight--
      // Invalidated meanwhile: a newer entry owns the id.
      if (this.entries.get(id) !== e) return
      e.url = url
      const waiters = e.waiters ?? []
      e.waiters = null
      for (const w of waiters) w(url)
      this.notify(id)
    }
    result.then(settle, () => settle(null))
  }

  /** Calls `apply` with the URL now (known) or once the resolver finishes. */
  resolve(id: string, apply: (url: string | null) => void): void {
    const e = this.entry(id)
    if (e.url !== undefined) {
      apply(e.failed ? null : e.url)
      return
    }
    ;(e.waiters ??= []).push(apply)
  }

  /** The URL when known (`undefined` while resolving; resolution starts on first use). */
  peek(id: string): string | null | undefined {
    return this.entry(id).url
  }

  isMissing(id: string): boolean {
    const e = this.entry(id)
    return e.url === null || e.failed
  }

  /** Loading the asset failed somewhere (e.g. an image layer's <img> errored). */
  markFailed(id: string): void {
    const e = this.entries.get(id)
    if (!e || e.failed) return
    e.failed = true
    this.notify(id)
  }

  /**
   * Decoded image for drawing into a canvas (LOD thumbnails), or null while it loads (the
   * load starts here and `onChange` reports when it settles), when the asset is missing,
   * or when no untainted copy can be had (see `isUndrawable`).
   */
  drawable(id: string): HTMLImageElement | null {
    const e = this.entry(id)
    if (e.image || e.failed || e.undrawable || typeof e.url !== 'string') return e.image
    if (isTaintFree(e.url)) {
      this.probe(id, e)
      return null
    }
    if (e.drawLoading || typeof Image === 'undefined') return null
    // Cross-origin scheme: a CORS request keeps the thumbnail canvas exportable.
    e.drawLoading = true
    this.inflight++
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.src = e.url
    img.decode().then(
      () => this.settleDraw(id, e, img),
      () => this.settleDraw(id, e, null),
    )
    return null
  }

  private settleDraw(id: string, e: Entry, img: HTMLImageElement | null): void {
    this.inflight--
    if (this.entries.get(id) !== e) return
    e.drawLoading = false
    if (img) e.image = img
    else e.undrawable = true
    this.notify(id)
  }

  /**
   * An SVG layer as a decoded image for LOD thumbnails: standalone `markup` (see
   * `svgThumbMarkup`) loaded from a data URL, so drawing it never taints the canvas. Returns
   * the key a thumbnail waits on while it decodes (`onChange` reports it), the image once
   * decoded, and `failed` when it cannot be decoded.
   */
  svgDrawable(markup: string): { key: string; image: HTMLImageElement | null; failed: boolean } {
    const key = svgKey(markup)
    let e = this.svgs.get(key)
    if (!e || e.markup !== markup) {
      if (this.svgs.size >= MAX_SVG_IMAGES) {
        const oldest = this.svgs.keys().next()
        if (!oldest.done) this.svgs.delete(oldest.value)
      }
      const entry: SvgEntry = { markup, image: null, failed: typeof Image === 'undefined' }
      this.svgs.set(key, entry)
      e = entry
      if (!entry.failed) {
        this.inflight++
        const img = new Image()
        img.decoding = 'async'
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
        const settle = (ok: boolean) => {
          this.inflight--
          if (this.svgs.get(key) !== entry) return
          if (ok && img.naturalWidth > 0) entry.image = img
          else entry.failed = true
          this.notify(key)
        }
        img.decode().then(
          () => settle(true),
          () => settle(false),
        )
      }
    }
    return { key, image: e.image, failed: e.failed }
  }

  /** True once a drawable copy is known to be unavailable (thumbnails stop waiting). */
  isUndrawable(id: string): boolean {
    const e = this.entries.get(id)
    return e !== undefined && (e.undrawable || e.failed || e.url === null)
  }

  /** Start loading the URL once to learn whether it exists (fills have no error events). */
  probe(id: string, e: Entry = this.entry(id)): void {
    if (e.probing || e.exists || e.failed || typeof e.url !== 'string') return
    if (typeof Image === 'undefined') return
    e.probing = true
    this.inflight++
    const url = e.url
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    img.decode().then(
      () => {
        this.inflight--
        if (this.entries.get(id) !== e) return
        e.probing = false
        e.exists = true
        if (isTaintFree(url)) e.image = img
        this.notify(id)
      },
      () => {
        this.inflight--
        if (this.entries.get(id) !== e) return
        e.probing = false
        e.failed = true
        this.notify(id)
      },
    )
  }

  /**
   * CSS for a style value with every `url(baren-asset://…)` replaced: the resolved URL,
   * the missing placeholder, or `none` while resolving. Starts probes for URLs whose
   * existence is unknown, so a missing fill turns into the placeholder.
   */
  rewriteCss(value: string): string {
    return rewriteAssetUrls(value, (hash) => {
      const e = this.entry(hash)
      if (e.url === undefined) return 'none'
      if (e.url === null || e.failed) return MISSING_FILL_CSS
      this.probe(hash, e)
      return `url("${e.url.replace(/["\\\n]/g, (c) => `\\${c}`)}")`
    })
  }

  /** Forget what is known about `ids` (their bytes arrived or changed) and re-resolve them. */
  invalidate(ids: Iterable<string>): void {
    for (const id of ids) {
      if (!this.entries.delete(id)) continue
      this.notify(id)
    }
  }

  private notify(id: string): void {
    if (!this.changed) {
      this.changed = new Set()
      queueMicrotask(() => {
        const ids = this.changed
        this.changed = null
        if (ids && ids.size > 0) this.onChange(ids)
      })
    }
    this.changed.add(id)
  }
}
