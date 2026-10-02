/**
 * The render window page (`#/agent-render`, contract §4.7, §11.5): a hidden off-screen window
 * main captures for screenshots and image exports. It answers the render-window requests
 * (`fileId: null`): stage_prepare, stage_styles, stage_clear, fonts_probe, image_transcode.
 */
import { useEffect } from 'react'
import { bridge } from '../../lib/bridge'
import { ensureDesignFonts } from '../../editor/lib/fonts'
import type { AgentRequest, AgentResponse, RenderJob } from '../../types/bridge'
import { AgentToolError, toAgentError } from '../errors'
import { canvasFontDetector, fontFamilyInfo } from './fonts'
import { RenderStage } from './stage'

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function isJob(v: unknown): v is RenderJob {
  const j = rec(v)
  const stage = rec(j['stage'])
  return typeof j['nodeId'] === 'string' && typeof stage['html'] === 'string'
}

/** Decode, fit into `maxSide`, re-encode (JPEG composited on white). */
export async function transcode(
  bytes: Uint8Array,
  to: 'jpeg' | 'webp' | 'png',
  maxSide: number | null,
  quality: number,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]))
  try {
    let w = bitmap.width
    let h = bitmap.height
    if (maxSide !== null && maxSide > 0 && Math.max(w, h) > maxSide) {
      const s = maxSide / Math.max(w, h)
      w = Math.max(1, Math.round(w * s))
      h = Math.max(1, Math.round(h * s))
    }
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new AgentToolError('internal', 'No 2D canvas available.')
    if (to === 'jpeg') {
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, w, h)
    }
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await canvas.convertToBlob({ type: `image/${to}`, quality })
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h }
  } finally {
    bitmap.close()
  }
}

export async function handleRenderRequest(
  stage: RenderStage,
  req: AgentRequest,
): Promise<AgentResponse> {
  try {
    const args = rec(req.args)
    let result: unknown
    switch (req.tool) {
      case 'stage_prepare': {
        if (!isJob(args['job'])) throw new AgentToolError('invalid_argument', 'Missing render job.')
        const maxPixels = args['maxPixels']
        result = await stage.prepare({
          job: args['job'],
          scale: typeof args['scale'] === 'number' ? args['scale'] : 1,
          maxSide: typeof args['maxSide'] === 'number' ? args['maxSide'] : Number.POSITIVE_INFINITY,
          maxPixels: typeof maxPixels === 'number' ? maxPixels : null,
          transparent: args['transparent'] === true,
        })
        break
      }
      case 'stage_styles': {
        if (!isJob(args['job'])) throw new AgentToolError('invalid_argument', 'Missing render job.')
        const ids = Array.isArray(args['nodeIds'])
          ? args['nodeIds'].filter((x): x is string => typeof x === 'string')
          : args['job'].ids
        result = { styles: await stage.styles(args['job'], ids) }
        break
      }
      case 'stage_clear':
        stage.clear()
        result = { cleared: true }
        break
      case 'fonts_probe': {
        await ensureDesignFonts().catch(() => undefined)
        const names = Array.isArray(args['familyNames'])
          ? args['familyNames'].filter((x): x is string => typeof x === 'string')
          : []
        result = { families: fontFamilyInfo(names, canvasFontDetector()) }
        break
      }
      case 'image_transcode': {
        const to = args['to'] === 'webp' || args['to'] === 'png' ? args['to'] : 'jpeg'
        let bytes: Uint8Array | null = null
        if (typeof args['hash'] === 'string') bytes = await bridge.assets.get(args['hash'])
        else if (args['png'] instanceof Uint8Array) bytes = args['png']
        if (!bytes) throw new AgentToolError('node_not_found', 'The image is not on this computer.')
        const maxSide = typeof args['maxSide'] === 'number' ? args['maxSide'] : null
        const quality = typeof args['quality'] === 'number' ? args['quality'] : 0.92
        result = await transcode(bytes, to, maxSide, quality > 1 ? quality / 100 : quality)
        break
      }
      default:
        throw new AgentToolError('unsupported', `The render window does not run ${req.tool}.`)
    }
    return { id: req.id, ok: true, header: null, result }
  } catch (error) {
    return { id: req.id, ok: false, error: toAgentError(error) }
  }
}

export function RenderRoot() {
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    void ensureDesignFonts()
    const stage = new RenderStage()
    const agent = bridge.agent as typeof bridge.agent | undefined
    if (!agent) return
    // One stage job at a time (main serialises too).
    let queue: Promise<unknown> = Promise.resolve()
    const off = agent.onRequest((req) => {
      if (req.fileId !== null) return
      const next = queue.then(() => handleRenderRequest(stage, req))
      queue = next.catch(() => undefined)
      void next.then((res) => agent.respond(res))
    })
    return () => {
      off()
      stage.clear()
    }
  }, [])
  return null
}
