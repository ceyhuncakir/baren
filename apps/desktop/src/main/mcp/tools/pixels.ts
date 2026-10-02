/**
 * Tools that need pixels (contract §6.14–§6.17, §6.30, §9): screenshots, fill images, fonts,
 * browser-computed styles and export. The host builds a render job, the shared render window
 * (render.ts) turns it into pixels, main encodes and writes files.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentErrorCode, FileHeader, RenderJob } from '../../../renderer/types/bridge'
import { imageSize, sniffImage } from '../assets'
import {
  ToolError,
  headerText,
  imageBlock,
  isToolError,
  okResult,
  textBlock,
  type ToolContent,
  type ToolResult,
} from '../format'
import { EXPORT_MAX_SIDE, SCREENSHOT_LIMITS } from '../render'
import { underDeadline, type SessionRef, type ToolRuntime } from './context'
import { runHostTool } from './host'
import type { ToolArgs } from './schemas'

const round2 = (n: number): number => Math.round(n * 100) / 100

function isRenderJob(value: unknown): value is RenderJob {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const stage = v['stage'] as Record<string, unknown> | undefined
  return (
    typeof v['nodeId'] === 'string' &&
    typeof stage === 'object' &&
    stage !== null &&
    typeof stage['html'] === 'string' &&
    typeof stage['css'] === 'string'
  )
}

function asRenderJob(value: unknown): RenderJob {
  if (!isRenderJob(value)) throw new ToolError('internal', 'The host returned no render job')
  return value
}

// ---------------------------------------------------------------------------
// get_screenshot
// ---------------------------------------------------------------------------

export async function getScreenshot(
  rt: ToolRuntime,
  session: SessionRef,
  args: ToolArgs<'get_screenshot'>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const ref = await rt.resolveFile(args.fileId)
  const requested = Math.min(4, Math.max(0.1, args.scale ?? 1))
  return underDeadline(signal, rt.env.deadlines.screenshot, 'get_screenshot', async (sig) => {
    const res = await rt.callHost(
      session,
      ref.fileId,
      'render_job',
      { nodeId: args.nodeId, scale: requested, purpose: 'screenshot' },
      { write: false, timeoutMs: rt.env.deadlines.render, signal: sig },
    )
    const cap = await rt.env.render.capture(asRenderJob(res.result), {
      scale: requested,
      maxSide: SCREENSHOT_LIMITS.maxSide,
      maxPixels: SCREENSHOT_LIMITS.maxPixels,
      transparent: false,
      format: 'jpeg',
      quality: 90,
      signal: sig,
      timeoutMs: rt.env.deadlines.render,
    })
    // The header, then the image (no JSON body).
    const content: ToolContent[] = []
    if (res.header) content.push(textBlock(headerText(res.header)))
    content.push(imageBlock(cap.bytes, 'image/jpeg'))
    if (cap.scale < requested - 1e-6) {
      content.push(
        textBlock(`Downscaled to fit size limits (effective scale ${round2(cap.scale)}).`),
      )
    }
    return { content }
  })
}

// ---------------------------------------------------------------------------
// get_fill_image
// ---------------------------------------------------------------------------

export async function getFillImage(
  rt: ToolRuntime,
  session: SessionRef,
  args: ToolArgs<'get_fill_image'>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const ref = await rt.resolveFile(args.fileId)
  const res = await rt.callHost(
    session,
    ref.fileId,
    'node_image',
    { nodeId: args.nodeId },
    { write: false, timeoutMs: rt.env.deadlines.read, signal },
  )
  const info = (res.result ?? {}) as {
    assetId?: unknown
    mime?: unknown
    name?: unknown
    svg?: unknown
  }
  if (typeof info.svg === 'string') {
    throw new ToolError('invalid_target', 'This is a vector layer; use get_jsx')
  }
  if (typeof info.assetId !== 'string') {
    throw new ToolError('invalid_target', 'This node has no image (no image layer or image fill)')
  }
  const bytes = await (await rt.env.core()).getAsset(info.assetId)
  if (!bytes) {
    throw new ToolError(
      'node_not_found',
      'The image data is not on this computer yet (it may still be downloading); try again shortly',
    )
  }
  const sniffed = sniffImage(bytes)
  const mime =
    typeof info.mime === 'string'
      ? info.mime
      : sniffed?.kind === 'raster'
        ? sniffed.mime
        : 'image/svg+xml'
  const natural = imageSize(bytes)
  let jpeg = rt.env.codec.toJpeg(bytes, SCREENSHOT_LIMITS.maxSide, 85)
  if (!jpeg) {
    const t = await rt.env.render.transcode({ hash: info.assetId }, 'jpeg', {
      maxSide: SCREENSHOT_LIMITS.maxSide,
      quality: 0.85,
      signal,
    })
    jpeg = { bytes: t.bytes, width: t.width ?? 0, height: t.height ?? 0 }
  }
  const body = {
    nodeId: args.nodeId,
    assetId: info.assetId,
    mime,
    name: typeof info.name === 'string' ? info.name : null,
    width: natural?.width ?? null,
    height: natural?.height ?? null,
  }
  return okResult(res.header, body, [imageBlock(jpeg.bytes, 'image/jpeg')])
}

// ---------------------------------------------------------------------------
// get_font_family_info
// ---------------------------------------------------------------------------

export async function getFontFamilyInfo(
  rt: ToolRuntime,
  args: ToolArgs<'get_font_family_info'>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const body = await underDeadline(signal, rt.env.deadlines.render, 'get_font_family_info', (sig) =>
    rt.env.render.fonts(args.familyNames, sig),
  )
  return okResult(null, body)
}

// ---------------------------------------------------------------------------
// get_computed_styles (resolved: true)
// ---------------------------------------------------------------------------

interface EntryError {
  index: number
  id?: string
  code: AgentErrorCode
  message: string
}

export async function getComputedStyles(
  rt: ToolRuntime,
  session: SessionRef,
  args: ToolArgs<'get_computed_styles'>,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (args.resolved !== true) return runHostTool(rt, session, 'get_computed_styles', args, signal)
  const ref = await rt.resolveFile(args.fileId)
  return underDeadline(signal, rt.env.deadlines.render * 2, 'get_computed_styles', async (sig) => {
    const map = await rt.callHost(
      session,
      ref.fileId,
      'artboards_of',
      { nodeIds: args.nodeIds },
      { write: false, timeoutMs: rt.env.deadlines.read, signal: sig },
    )
    let header: FileHeader | null = map.header
    const artboards =
      (map.result as { artboards?: Record<string, string | null> } | null)?.artboards ?? {}
    const groups = new Map<string, string[]>()
    const errors: EntryError[] = []
    args.nodeIds.forEach((id, index) => {
      const artboard = artboards[id]
      if (artboard === undefined) {
        errors.push({ index, id, code: 'node_not_found', message: `No node with ID ${id}` })
      } else if (artboard === null) {
        errors.push({ index, id, code: 'invalid_target', message: 'Pages have no computed styles' })
      } else {
        const list = groups.get(artboard) ?? []
        list.push(id)
        groups.set(artboard, list)
      }
    })
    const styles: Record<string, unknown> = {}
    for (const [artboard, ids] of groups) {
      try {
        const job = await rt.callHost(
          session,
          ref.fileId,
          'render_job',
          { nodeId: artboard, scale: 1, purpose: 'styles', nodeIds: ids },
          { write: false, timeoutMs: rt.env.deadlines.render, signal: sig },
        )
        header = job.header ?? header
        const res = (await rt.env.render.styles(asRenderJob(job.result), ids, sig)) as {
          styles?: Record<string, unknown>
        } | null
        Object.assign(styles, res?.styles ?? {})
      } catch (error) {
        if (!isToolError(error) || error.code === 'cancelled' || error.code === 'timeout')
          throw error
        for (const id of ids) {
          errors.push({
            index: args.nodeIds.indexOf(id),
            id,
            code: error.code,
            message: error.message,
          })
        }
      }
    }
    const body = errors.length > 0 ? { styles, errors } : { styles }
    const result = okResult(header, body)
    if (Object.keys(styles).length === 0 && errors.length > 0) result.isError = true
    return result
  })
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export interface ParsedScale {
  value: number
  unit: 'x' | 'w' | 'h' | 'p'
}

export function parseScale(scale: string): ParsedScale | null {
  const m = /^(\d+(?:\.\d+)?)(x|w|h|p)$/.exec(scale.trim())
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return { value, unit: m[2] as ParsedScale['unit'] }
}

/** The multiplier for a node of CSS size `width × height`. */
export function exportMultiplier(scale: ParsedScale, width: number, height: number): number {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  switch (scale.unit) {
    case 'x':
      return scale.value
    case 'w':
      return scale.value / w
    case 'h':
      return scale.value / h
    case 'p':
      return scale.value / Math.min(w, h)
  }
}

/** `/\:*?"<>|` and control characters → `-` (contract §6.30). */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
  return cleaned || 'Untitled'
}

/** `<base>.<ext>`, else `<base> (2).<ext>`, `<base> (3).<ext>`… */
export async function uniquePath(
  dir: string,
  base: string,
  ext: string,
  exists: (path: string) => Promise<boolean> = async (p) =>
    stat(p).then(
      () => true,
      () => false,
    ),
  taken: ReadonlySet<string> = new Set(),
): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}.${ext}` : `${base} (${i}).${ext}`
    const path = join(dir, name)
    if (!taken.has(path) && !(await exists(path))) return path
  }
}

const EXTENSIONS: Record<string, string> = {
  png: 'png',
  jpg: 'jpg',
  webp: 'webp',
  svg: 'svg',
  pdf: 'pdf',
}

interface NodeFacts {
  name: string
  width: number | null
  height: number | null
}

export async function exportNodes(
  rt: ToolRuntime,
  session: SessionRef,
  args: ToolArgs<'export'>,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (args.nodes === 'nodes-with-exports-only') {
    throw new ToolError(
      'unsupported',
      'Baren has no export settings; pass node IDs, e.g. { "<nodeId>": [{ "format": "png", "scale": "1x" }] }',
    )
  }
  const ref = await rt.resolveFile(args.fileId)
  const nodes = args.nodes
  return underDeadline(signal, rt.env.deadlines.export, 'export', async (sig) => {
    const files: {
      nodeId: string
      format: string
      scale: string
      path: string
      width: number
      height: number
      bytes: number
    }[] = []
    const errors: EntryError[] = []
    const written = new Set<string>()
    let header: FileHeader | null = rt.headerFor(ref.fileId)
    let dir: string | null = null
    let index = 0
    const outDir = async (): Promise<string> => {
      if (dir !== null) return dir
      const name = header?.file.name ?? (await rt.fileMeta(ref.fileId))?.name ?? ref.fileId
      dir = rt.env.app.exportDir(sanitizeFileName(name))
      await mkdir(dir, { recursive: true })
      return dir
    }
    const fail = (nodeId: string, error: unknown): void => {
      if (isToolError(error) && (error.code === 'cancelled' || error.code === 'timeout'))
        throw error
      const code: AgentErrorCode = isToolError(error) ? error.code : 'internal'
      errors.push({
        index,
        id: nodeId,
        code,
        message: error instanceof Error ? error.message : String(error),
      })
    }

    for (const [nodeId, rawSettings] of Object.entries(nodes)) {
      const settings =
        rawSettings.length > 0 ? rawSettings : [{ format: 'png' as const, scale: '1x' }]
      let facts: NodeFacts
      let job: RenderJob | null = null
      try {
        const info = await rt.callHost(
          session,
          ref.fileId,
          'get_node_info',
          { nodeId },
          { write: false, timeoutMs: rt.env.deadlines.read, signal: sig },
        )
        header = info.header ?? header
        const r = (info.result ?? {}) as Record<string, unknown>
        facts = {
          name: typeof r['name'] === 'string' && r['name'] ? r['name'] : nodeId,
          width: typeof r['width'] === 'number' ? r['width'] : null,
          height: typeof r['height'] === 'number' ? r['height'] : null,
        }
      } catch (error) {
        for (let i = 0; i < settings.length; i++, index++) fail(nodeId, error)
        continue
      }

      for (const setting of settings) {
        try {
          if (args.type === 'video' || ['avif', 'mp4', 'webm'].includes(setting.format)) {
            throw new ToolError(
              'unsupported',
              `${args.type === 'video' ? 'Video' : setting.format.toUpperCase()} export is not available; use png, jpg, webp, svg or pdf`,
            )
          }
          const scale = parseScale(setting.scale)
          if (!scale) throw new ToolError('invalid_argument', `Invalid scale "${setting.scale}"`)
          let bytes: Uint8Array
          let width: number
          let height: number
          if (setting.format === 'svg') {
            const img = await rt.callHost(
              session,
              ref.fileId,
              'node_image',
              { nodeId },
              { write: false, timeoutMs: rt.env.deadlines.read, signal: sig },
            )
            const svg = (img.result as { svg?: unknown } | null)?.svg
            if (typeof svg !== 'string') {
              throw new ToolError(
                'invalid_target',
                'SVG export works for vector and SVG layers only; export this node as png',
              )
            }
            bytes = new TextEncoder().encode(svg)
            width = Math.round(facts.width ?? 0)
            height = Math.round(facts.height ?? 0)
          } else {
            if (!job) {
              const res = await rt.callHost(
                session,
                ref.fileId,
                'render_job',
                { nodeId, scale: 1, purpose: 'export' },
                { write: false, timeoutMs: rt.env.deadlines.render, signal: sig },
              )
              header = res.header ?? header
              job = asRenderJob(res.result)
            }
            if (setting.format === 'pdf') {
              const pdf = await rt.env.render.pdf(job, {
                signal: sig,
                timeoutMs: rt.env.deadlines.render,
              })
              bytes = pdf.bytes
              width = pdf.width
              height = pdf.height
            } else {
              const cssW = job.width ?? facts.width
              const cssH = job.height ?? facts.height
              if (cssW === null || cssH === null) {
                throw new ToolError('internal', 'The node has no measurable size')
              }
              const m = exportMultiplier(scale, cssW, cssH)
              const longSide = Math.ceil(Math.max(cssW, cssH) * m)
              if (longSide > EXPORT_MAX_SIDE) {
                const max = EXPORT_MAX_SIDE / Math.max(1, cssW, cssH)
                throw new ToolError(
                  'too_large',
                  `The output would be ${longSide} px on its long side (limit ${EXPORT_MAX_SIDE}); the largest allowed scale is ${Math.floor(max * 100) / 100}x`,
                )
              }
              const cap = await rt.env.render.capture(job, {
                scale: m,
                maxSide: EXPORT_MAX_SIDE,
                maxPixels: Number.POSITIVE_INFINITY,
                transparent: true,
                format:
                  setting.format === 'jpg' ? 'jpeg' : setting.format === 'webp' ? 'webp' : 'png',
                quality: 92,
                signal: sig,
                timeoutMs: rt.env.deadlines.render,
              })
              bytes = cap.bytes
              width = cap.width
              height = cap.height
            }
          }
          const base = `${sanitizeFileName(facts.name)}@${setting.scale}`
          const path = await uniquePath(
            await outDir(),
            base,
            EXTENSIONS[setting.format] ?? setting.format,
            undefined,
            written,
          )
          await writeFile(path, bytes, { flag: 'wx' })
          written.add(path)
          files.push({
            nodeId,
            format: setting.format,
            scale: setting.scale,
            path,
            width,
            height,
            bytes: bytes.byteLength,
          })
        } catch (error) {
          fail(nodeId, error)
        }
        index++
      }
    }
    const body = errors.length > 0 ? { files, errors } : { files }
    const result = okResult(header, body)
    if (files.length === 0 && errors.length > 0) result.isError = true
    return result
  })
}
