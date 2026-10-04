/**
 * The render window's stage (contract §4.7, §11.5): one fixed host element at the window's
 * top-left with an open shadow root, so the app's global CSS cannot reach the staged node.
 * `prepare` builds a `RenderJob`'s HTML, waits for fonts and images, measures the stage root and
 * scales it to the effective output scale; main then captures the window.
 */
import { ensureFontFamilies } from '../../editor/lib/fonts'
import { familyList } from '../../lib/googleFonts'
import type { RenderJob } from '../../types/bridge'
import { STAGE_BASE_CSS, bodyTextStyles } from '../measure'
import { stageComputedStyles } from './styles'

export interface PrepareArgs {
  job: RenderJob
  scale: number
  maxSide: number
  maxPixels: number | null
  transparent: boolean
}

export interface PrepareResult {
  width: number
  height: number
  scale: number
  outWidth: number
  outHeight: number
}

/**
 * Font families a stage may use: `font-family` declarations and custom property values (what
 * `var(--font-…)` tokens resolve to). Values that are not font names are skipped later, by the
 * Google Fonts lookup.
 */
export function stageFontFamilies(stage: RenderJob['stage']): Set<string> {
  const out = new Set<string>()
  const styles = [...stage.html.matchAll(/\sstyle="([^"]*)"/g)].map(([, v]) => decodeAttr(v ?? ''))
  for (const source of [stage.css, ...styles]) {
    for (const [, value] of source.matchAll(/(?:font-family|--[\w-]+)\s*:\s*([^;{}]+)/g)) {
      for (const family of familyList(value ?? '')) out.add(family)
    }
  }
  return out
}

function decodeAttr(value: string): string {
  return value.replace(/&(quot|#34|#39|apos|lt|gt|amp);/g, (_, e: string) =>
    e === 'quot' || e === '#34'
      ? '"'
      : e === '#39' || e === 'apos'
        ? "'"
        : e === 'lt'
          ? '<'
          : e === 'gt'
            ? '>'
            : '&',
  )
}

/** Contract §4.7 step 2: the scale the output is rendered at. */
export function effectiveScale(
  width: number,
  height: number,
  scale: number,
  maxSide: number,
  maxPixels: number | null,
): number {
  let s = scale > 0 ? scale : 1
  const side = Math.max(width, height)
  if (side > 0 && Number.isFinite(maxSide) && maxSide > 0) s = Math.min(s, maxSide / side)
  const area = width * height
  if (area > 0 && maxPixels !== null && Number.isFinite(maxPixels) && maxPixels > 0) {
    s = Math.min(s, Math.sqrt(maxPixels / area))
  }
  // Never below one output pixel per side.
  if (side > 0) s = Math.max(s, 1 / side)
  return s
}

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

function timeout(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class RenderStage {
  private host: HTMLDivElement | null = null
  private shadow: ShadowRoot | null = null

  private open(): ShadowRoot {
    if (this.shadow && this.host?.isConnected) return this.shadow
    const host = document.createElement('div')
    host.setAttribute('data-agent-render-stage', '')
    host.style.cssText =
      'all:initial;position:fixed;left:0;top:0;display:block;margin:0;padding:0;overflow:visible;'
    document.body.appendChild(host)
    this.host = host
    this.shadow = host.attachShadow({ mode: 'open' })
    return this.shadow
  }

  /** Build the job's stage (no scaling); resolves once fonts and images are ready (≤ 5 s). */
  async build(job: RenderJob, transparent: boolean): Promise<HTMLElement> {
    // Google Fonts the design uses, registered before layout so their loads start with it.
    await Promise.race([ensureFontFamilies(stageFontFamilies(job.stage)), timeout(3_000)])
    const shadow = this.open()
    const host = this.host as HTMLDivElement
    host.style.background = 'transparent'
    for (const [name, value] of Object.entries(bodyTextStyles()))
      host.style.setProperty(name, value)
    const style = document.createElement('style')
    style.textContent = `${STAGE_BASE_CSS}\n${job.stage.css}`
    const container = document.createElement('div')
    container.setAttribute('data-stage-root', '')
    container.style.cssText =
      'position:absolute;left:0;top:0;width:max-content;transform-origin:0 0;'
    if (!transparent && job.background) container.style.background = job.background
    container.innerHTML = job.stage.html
    shadow.replaceChildren(style, container)
    // Lay out now: font faces start loading when text is shaped, and `fonts.ready` only waits
    // for loads that have started.
    void container.offsetHeight
    const waits: Promise<unknown>[] = []
    if (document.fonts) waits.push(document.fonts.ready)
    for (const img of container.querySelectorAll('img'))
      waits.push(img.decode().catch(() => undefined))
    for (const url of job.stage.assetUrls) {
      const img = new Image()
      img.src = url
      waits.push(img.decode().catch(() => undefined))
    }
    await Promise.race([Promise.all(waits), timeout(5_000)])
    return container
  }

  async prepare(args: PrepareArgs): Promise<PrepareResult> {
    const container = await this.build(args.job, args.transparent)
    const root = (container.firstElementChild as HTMLElement | null) ?? container
    const r = root.getBoundingClientRect()
    const width = r.width || args.job.width || 0
    const height = r.height || args.job.height || 0
    const s = effectiveScale(width, height, args.scale, args.maxSide, args.maxPixels)
    container.style.width = `${width}px`
    container.style.height = `${height}px`
    container.style.transform = `scale(${s})`
    await frame()
    await frame()
    return {
      width,
      height,
      scale: s,
      outWidth: Math.max(1, Math.ceil(width * s)),
      outHeight: Math.max(1, Math.ceil(height * s)),
    }
  }

  async styles(
    job: RenderJob,
    nodeIds: readonly string[],
  ): Promise<Record<string, Record<string, string>>> {
    const container = await this.build(job, true)
    try {
      return stageComputedStyles(container, nodeIds)
    } finally {
      this.clear()
    }
  }

  clear(): void {
    this.shadow?.replaceChildren()
  }
}
