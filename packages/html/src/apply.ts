/**
 * write_html applier (contract §7.1–7.9): IR → Loro nodes. Never commits: the runtime wraps
 * the call in `transact(doc, …, { origin: 'agent:write_html' })`. Every check that can refuse
 * the call (target, size, cycles, clone sources) runs before the first mutation, because Loro
 * has no rollback.
 */
import type { LoroDoc } from 'loro-crdt'
import {
  CONTAINER_NODE_TYPES,
  base64ToBytes,
  createNode,
  deleteNode,
  fitGroups,
  getNode,
  isTreeId,
  parseVirtualId,
  pasteClipboard,
  positionContextOf,
  sanitizeSvgMarkup,
  serializeClipboard,
  setNodeProps,
  setStyles,
  setStylesAt,
  wouldCreateCycleForKeys,
  type ClipNode,
  type ClipboardPayload,
  type CreateNodeInput,
  type DesignNode,
  type StylePatch,
  type StyleValue,
  type Styles,
} from '@baren/schema'
import { clearedFamilyKeys, resolveStyleImages } from './css/normalize.ts'
import { MAX_CREATED_NODES } from './parse.ts'
import { svgRootAttrs, viewBoxSize } from './svg.ts'
import type {
  ApplyContext,
  ApplyResult,
  ApplyTarget,
  HtmlApplyErrorCode,
  IrNode,
  ParsedHtml,
  ResolvedImage,
} from './types.ts'
import { Warnings } from './warnings.ts'

export class HtmlApplyError extends Error {
  readonly code: HtmlApplyErrorCode
  constructor(code: HtmlApplyErrorCode, message: string) {
    super(message)
    this.name = 'HtmlApplyError'
    this.code = code
  }
}

const PX_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+))(px)?\s*$/i

function px(v: StyleValue | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const m = PX_RE.exec(v)
  return m ? Number(m[1]) : null
}

const round2 = (n: number): number => {
  const r = Math.round(n * 100) / 100
  return r === 0 ? 0 : r
}

/** A patch without `null` entries (creation never removes). */
function present(patch: StylePatch): Styles {
  const out: Styles = {}
  for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) out[k] = v
  return out
}

function walkIr(nodes: readonly IrNode[], fn: (n: IrNode) => void): void {
  const stack = [...nodes]
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    fn(n)
    if (n.kind === 'frame') for (const c of n.children) stack.push(c)
  }
}

function clipSize(nodes: readonly ClipNode[]): number {
  let n = 0
  const stack = [...nodes]
  for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
    n++
    for (const k of c.children) stack.push(k)
  }
  return n
}

function clipInstanceKeys(payload: ClipboardPayload): string[] {
  const out = new Set<string>()
  const stack = [...payload.nodes]
  for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
    if (c.type === 'instance' && c.componentKey !== undefined) out.add(c.componentKey)
    for (const k of c.children) stack.push(k)
  }
  return [...out]
}

function pageOf(doc: LoroDoc, id: string): string {
  let cur = getNode(doc, id)
  for (let i = 0; cur && cur.parentId !== null && i < 512; i++) cur = getNode(doc, cur.parentId)
  return cur?.id ?? ''
}

/** Decode `data:image/svg+xml[;base64],…` (null for anything else). */
export function decodeSvgDataUri(src: string): string | null {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/is.exec(src.trim())
  if (!m) return null
  const params = (m[1] ?? '').toLowerCase()
  const body = m[2] as string
  if (params.includes(';base64')) {
    const bytes = base64ToBytes(body.replace(/\s+/g, ''))
    if (!bytes) return null
    return utf8Decode(bytes)
  }
  try {
    return decodeURIComponent(body)
  } catch {
    return body
  }
}

function utf8Decode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i] as number
    let cp: number
    let n: number
    if (b < 0x80) {
      cp = b
      n = 1
    } else if (b >> 5 === 6) {
      cp = ((b & 31) << 6) | ((bytes[i + 1] ?? 0) & 63)
      n = 2
    } else if (b >> 4 === 14) {
      cp = ((b & 15) << 12) | (((bytes[i + 1] ?? 0) & 63) << 6) | ((bytes[i + 2] ?? 0) & 63)
      n = 3
    } else {
      cp =
        ((b & 7) << 18) |
        (((bytes[i + 1] ?? 0) & 63) << 12) |
        (((bytes[i + 2] ?? 0) & 63) << 6) |
        ((bytes[i + 3] ?? 0) & 63)
      n = 4
    }
    out += cp > 0x10ffff ? '�' : String.fromCodePoint(cp)
    i += n
  }
  return out
}

type ImageResult = ResolvedImage | { error: string }

/** Default size of an SVG source: its width/height attributes, else its viewBox, else 24×24. */
function svgNaturalSize(markup: string): { width: number; height: number } {
  const a = svgRootAttrs(markup)
  const w = px(a.width)
  const h = px(a.height)
  const vb = viewBoxSize(a.viewBox)
  if (w !== null && h !== null) return { width: w, height: h }
  if (vb) {
    if (w !== null) return { width: w, height: round2((w * vb.height) / vb.width) }
    if (h !== null) return { width: round2((h * vb.width) / vb.height), height: h }
    return vb
  }
  return { width: w ?? 24, height: h ?? 24 }
}

const POSITION_KEYS = ['position', 'left', 'top', 'right', 'bottom', 'inset'] as const

/** What the applier needs to know about a parent (no full decode for nodes it just created). */
type Parent = Pick<DesignNode, 'id' | 'type' | 'styles'>

class Applier {
  readonly w = new Warnings()
  private readonly images = new Map<string, ImageResult>()
  private readonly clones = new Map<IrNode, ClipboardPayload>()
  private replacedArtboard: DesignNode | null = null
  private firstRoot = true

  readonly doc: LoroDoc
  readonly ctx: ApplyContext

  constructor(doc: LoroDoc, ctx: ApplyContext) {
    this.doc = doc
    this.ctx = ctx
  }

  image(src: string): ImageResult {
    const hit = this.images.get(src)
    if (hit) return hit
    let r: ImageResult
    if (src === '') r = { error: 'the src attribute is empty' }
    else {
      const looked = this.ctx.image(src)
      if (looked !== null) r = looked
      else {
        const svg = decodeSvgDataUri(src)
        const hash = /^baren-asset:\/\/([0-9a-f]{64})$/.exec(src)?.[1]
        if (svg !== null) r = { kind: 'svg', markup: svg, name: 'SVG' }
        else if (hash !== undefined)
          r = {
            kind: 'raster',
            hash,
            mime: 'application/octet-stream',
            name: 'Image',
            width: null,
            height: null,
          }
        else r = { error: 'the source was not resolved' }
      }
    }
    this.images.set(src, r)
    return r
  }

  /** Clone payloads, the cycle check and the size limit — all before any mutation. */
  prepare(parsed: ParsedHtml, parentId: string): void {
    let clones = 0
    let cloneNodes = 0
    walkIr(parsed.roots, (n) => {
      if (n.kind !== 'clone') return
      clones++
      const ref = n.nodeId
      const virtual = parseVirtualId(ref)
      const real = virtual?.instanceId ?? ref
      const node = isTreeId(real) ? getNode(this.doc, real) : undefined
      if (!node || node.type === 'page') {
        this.w.add(
          'clone-not-found',
          node
            ? `node-id ${ref} is a page; pages cannot be cloned.`
            : `node-id ${ref} does not exist in this file; nothing was copied.`,
          { path: n.path },
        )
        return
      }
      const payload = serializeClipboard(this.doc, [ref], {
        geo: this.ctx.geometry,
        fileId: this.ctx.fileId,
        pageId: pageOf(this.doc, real),
        app: 'Baren',
        resolver: this.ctx.resolver,
      })
      if (!payload || payload.nodes.length === 0) {
        this.w.add('clone-not-found', `node-id ${ref} could not be copied.`, { path: n.path })
        return
      }
      if (wouldCreateCycleForKeys(this.doc, clipInstanceKeys(payload), parentId)) {
        throw new HtmlApplyError(
          'cycle',
          `Cloning ${ref} here would put a component inside itself.`,
        )
      }
      cloneNodes += clipSize(payload.nodes)
      this.clones.set(n, payload)
    })
    const total = parsed.nodeCount - clones + cloneNodes
    if (total > MAX_CREATED_NODES) {
      throw new HtmlApplyError(
        'too_large',
        `This HTML creates ${total} layers; the limit is ${MAX_CREATED_NODES} per call. Split it into several write_html calls.`,
      )
    }
    walkIr(parsed.roots, (n) => {
      if (n.kind === 'image') this.image(n.src)
    })
  }

  /** True when at least one root will be created (clones with a payload count). */
  createsAnything(parsed: ParsedHtml): boolean {
    return parsed.roots.some((r) => r.kind !== 'clone' || this.clones.has(r))
  }

  setReplaced(node: DesignNode): void {
    this.replacedArtboard = node
  }

  /** Final styles of an IR node: images resolved, `null`s dropped. */
  styles(n: IrNode): Styles {
    const { styles, warnings } = resolveStyleImages(n.styles, (src) => this.image(src), n.path)
    this.w.addAll(warnings)
    return present(styles)
  }

  /** Styles for a root inserted into `parent` (artboards on pages, absolute in groups). */
  placeRoot(
    n: IrNode,
    styles: Styles,
    parent: Parent,
    size: { width: number; height: number } | null,
  ): Styles {
    if (parent.type === 'page') {
      const out: Styles = { ...styles }
      for (const k of ['position', 'right', 'bottom', 'inset']) delete out[k]
      const replaced = this.firstRoot ? this.replacedArtboard : null
      if (n.kind === 'frame' || n.kind === 'clone') {
        const defaults: string[] = []
        if (n.kind === 'frame' && out['width'] === undefined) {
          out['width'] = replaced?.styles['width'] ?? '1440px'
          defaults.push(`width ${String(out['width'])}`)
        }
        if (n.kind === 'frame' && out['height'] === undefined) {
          out['height'] = replaced?.styles['height'] ?? 'fit-content'
          defaults.push(`height ${String(out['height'])}`)
        }
        if (defaults.length > 0) {
          this.w.add(
            'artboard-size-defaulted',
            `An artboard needs a size; it got ${defaults.join(' and ')}. Set width and height on top-level elements.`,
            { path: n.path },
          )
        }
      }
      if (px(out['left']) === null || px(out['top']) === null) {
        if (
          replaced &&
          px(replaced.styles['left']) !== null &&
          px(replaced.styles['top']) !== null
        ) {
          out['left'] ??= replaced.styles['left'] as StyleValue
          out['top'] ??= replaced.styles['top'] as StyleValue
        } else {
          const w = px(out['width']) ?? size?.width ?? 1440
          const h = px(out['height']) ?? size?.height ?? 900
          const spot = this.ctx.placeArtboard(parent.id, { width: w, height: h })
          if (px(out['left']) === null) out['left'] = spot.left
          if (px(out['top']) === null) out['top'] = spot.top
        }
      }
      return out
    }
    if (parent.type === 'group') {
      const out: Styles = { ...styles, position: 'absolute' }
      if (out['left'] === undefined) out['left'] = 0
      if (out['top'] === undefined) out['top'] = 0
      return out
    }
    return styles
  }

  create(n: IrNode, parent: Parent, index: number | undefined, root: boolean): string | null {
    const opts = this.ctx.random ? { random: this.ctx.random } : {}
    if (n.kind === 'clone') return this.clone(n, parent, index, root)
    let styles = this.styles(n)
    let input: CreateNodeInput
    switch (n.kind) {
      case 'frame':
        if (root) styles = this.placeRoot(n, styles, parent, null)
        input = { type: 'frame', parentId: parent.id, name: n.name ?? 'Frame', styles }
        break
      case 'text':
        if (styles['display'] === 'block') delete styles['display']
        if (root) styles = this.placeRoot(n, styles, parent, null)
        input = { type: 'text', parentId: parent.id, name: n.name ?? 'Text', styles, text: n.text }
        break
      case 'svg': {
        if (root) styles = this.placeRoot(n, styles, parent, null)
        input = { type: 'svg', parentId: parent.id, name: n.name ?? 'SVG', styles, svg: n.markup }
        break
      }
      case 'image': {
        const r = this.image(n.src)
        const res = this.imageInput(n, styles, r)
        styles = root ? this.placeRoot(n, res.styles, parent, res.size) : res.styles
        input = { ...res.input, parentId: parent.id, styles }
        break
      }
    }
    if (index !== undefined) input.index = index
    if (n.hidden) input.hidden = true
    const id = createNode(this.doc, input, opts)
    if (n.kind === 'frame') {
      const created: Parent = { id, type: 'frame', styles }
      for (const c of n.children) this.create(c, created, undefined, false)
    }
    return id
  }

  /** Node input for an `<img>`: raster image, svg layer, or a placeholder image. */
  imageInput(
    n: Extract<IrNode, { kind: 'image' }>,
    styles: Styles,
    r: ImageResult,
  ): {
    input: Omit<CreateNodeInput, 'parentId'>
    styles: Styles
    size: { width: number; height: number }
  } {
    const out: Styles = { ...styles }
    const sw = px(out['width'])
    const sh = px(out['height'])
    const hasW = out['width'] !== undefined
    const hasH = out['height'] !== undefined
    const fill = (
      natural: { width: number; height: number } | null,
      fallback: { width: number; height: number },
    ): void => {
      let w = hasW ? sw : n.attrWidth
      let h = hasH ? sh : n.attrHeight
      const ratio =
        natural && natural.width > 0 && natural.height > 0 ? natural.height / natural.width : null
      if (!hasW && w === null && h !== null && ratio !== null) w = round2(h / ratio)
      if (!hasH && h === null && w !== null && ratio !== null) h = round2(w * ratio)
      if (!hasW && w === null && !hasH && h === null) {
        w = natural?.width ?? fallback.width
        h = natural?.height ?? fallback.height
      }
      if (!hasW) out['width'] = w ?? fallback.width
      if (!hasH) out['height'] = h ?? fallback.height
    }
    if ('error' in r) {
      this.w.add(
        'image-unresolved',
        `Image ${short(n.src)} could not be loaded (${r.error}); a placeholder was created.`,
        { path: n.path },
      )
      fill(null, { width: 100, height: 100 })
      return {
        input: { type: 'image', name: n.name ?? 'Image' },
        styles: out,
        size: { width: px(out['width']) ?? 100, height: px(out['height']) ?? 100 },
      }
    }
    if (r.kind === 'svg') {
      const markup = sanitizeSvgMarkup(r.markup)
      const natural = svgNaturalSize(markup)
      fill(natural, natural)
      return {
        input: { type: 'svg', name: n.name ?? truncate(r.name) ?? 'SVG', svg: markup },
        styles: out,
        size: {
          width: px(out['width']) ?? natural.width,
          height: px(out['height']) ?? natural.height,
        },
      }
    }
    const natural =
      r.width !== null && r.height !== null ? { width: r.width, height: r.height } : null
    fill(natural, { width: 100, height: 100 })
    const input: Omit<CreateNodeInput, 'parentId'> = {
      type: 'image',
      name: n.name ?? truncate(r.name) ?? 'Image',
      assetId: r.hash,
    }
    if (r.name !== '') input.assetName = r.name
    return {
      input,
      styles: out,
      size: { width: px(out['width']) ?? 100, height: px(out['height']) ?? 100 },
    }
  }

  clone(
    n: Extract<IrNode, { kind: 'clone' }>,
    parent: Parent,
    index: number | undefined,
    root: boolean,
  ): string | null {
    const payload = this.clones.get(n)
    if (!payload) return null
    const pasteOpts: Parameters<typeof pasteClipboard>[2] = {
      parentId: parent.id,
      geo: this.ctx.geometry,
    }
    if (index !== undefined) pasteOpts.index = index
    if (this.ctx.random) pasteOpts.random = this.ctx.random
    const res = pasteClipboard(this.doc, payload, pasteOpts)
    if (res.refused === 'cycle')
      throw new HtmlApplyError(
        'cycle',
        `Cloning ${n.nodeId} here would put a component inside itself.`,
      )
    const id = res.ids[0]
    if (res.refused !== null || id === undefined) {
      this.w.add('clone-not-found', `node-id ${n.nodeId} could not be copied here.`, {
        path: n.path,
      })
      return null
    }
    const copy = getNode(this.doc, id) as DesignNode
    const own = this.styles(n)
    const patch: StylePatch = {}
    const context = positionContextOf(parent)
    const ownSetsPosition = POSITION_KEYS.some((k) => own[k] !== undefined)
    if ((context === 'flow' || context === 'absolute') && !ownSetsPosition) {
      for (const k of POSITION_KEYS) if (copy.styles[k] !== undefined) patch[k] = null
    }
    if (context === 'page' && root) {
      const base: Styles = { ...copy.styles }
      delete base['left']
      delete base['top']
      const placed = this.placeRoot(n, { ...base, ...own }, parent, {
        width: px(copy.styles['width']) ?? 1440,
        height: px(copy.styles['height']) ?? 900,
      })
      if (own['left'] === undefined) patch['left'] = placed['left'] as StyleValue
      if (own['top'] === undefined) patch['top'] = placed['top'] as StyleValue
    }
    const merged = clearedFamilyKeys({ ...patch, ...own }, copy.styles)
    if (Object.keys(merged).length > 0) {
      if (copy.type === 'instance') setStylesAt(this.doc, id, merged)
      else setStyles(this.doc, id, merged)
    }
    const props: { name?: string; hidden?: boolean } = {}
    if (n.name !== null) props.name = n.name
    if (n.hidden) props.hidden = true
    if (Object.keys(props).length > 0) setNodeProps(this.doc, id, props)
    return id
  }

  doneRoot(): void {
    this.firstRoot = false
  }
}

function short(src: string): string {
  return src.length > 80 ? `${src.slice(0, 77)}…` : src
}

function truncate(name: string | undefined): string | null {
  if (name === undefined) return null
  const chars = Array.from(name.trim())
  if (chars.length === 0) return null
  return chars.length > 50 ? chars.slice(0, 50).join('') : chars.join('')
}

/** Apply parsed HTML to the document (contract §7.2). Call inside `transact`. */
export function applyHtml(
  doc: LoroDoc,
  parsed: ParsedHtml,
  target: ApplyTarget,
  ctx: ApplyContext,
): ApplyResult {
  const id = target.targetId
  if (!isTreeId(id)) {
    if (parseVirtualId(id)) {
      throw new HtmlApplyError(
        'instance_content',
        `${id} is inside a component instance; its structure comes from the main component. Edit the main component instead.`,
      )
    }
    throw new HtmlApplyError('node_not_found', `Node ${id} does not exist.`)
  }
  const node = getNode(doc, id)
  if (!node) throw new HtmlApplyError('node_not_found', `Node ${id} does not exist.`)
  let parent: DesignNode
  let index: number | undefined
  let replacedId: string | null = null
  if (target.mode === 'insert-children') {
    if (!CONTAINER_NODE_TYPES.has(node.type)) {
      throw new HtmlApplyError(
        'invalid_target',
        `${node.type === 'instance' ? 'A component instance' : `A ${node.type} layer`} cannot contain children; use mode "replace", or target its parent frame.`,
      )
    }
    parent = node
  } else {
    if (node.type === 'page') {
      throw new HtmlApplyError(
        'invalid_target',
        'A page cannot be replaced; use mode "insert-children" to add artboards to it.',
      )
    }
    const p = node.parentId === null ? undefined : getNode(doc, node.parentId)
    if (!p) throw new HtmlApplyError('node_not_found', `The parent of ${id} does not exist.`)
    parent = p
    index = p.children.indexOf(id)
    replacedId = id
  }

  const applier = new Applier(doc, ctx)
  applier.w.addAll(parsed.warnings)
  applier.prepare(parsed, parent.id)

  if (replacedId !== null && !applier.createsAnything(parsed)) {
    throw new HtmlApplyError(
      'invalid_target',
      `The HTML creates no layers, so ${replacedId} was not replaced. Use delete_nodes to remove a layer.`,
    )
  }
  if (replacedId !== null) {
    if (parent.type === 'page') applier.setReplaced(node)
    deleteNode(doc, replacedId)
  }
  // Absolutely positioned roots are placed in the target frame (the canvas model).
  if (
    parent.type === 'frame' &&
    parent.styles['position'] === undefined &&
    parent.parentId !== null &&
    getNode(doc, parent.parentId)?.type !== 'page' &&
    parsed.roots.some((r) => r.styles['position'] === 'absolute')
  ) {
    setStyles(doc, parent.id, { position: 'relative' })
  }
  const created: string[] = []
  let i = 0
  for (const root of parsed.roots) {
    const at = index === undefined ? undefined : index + i
    const newId = applier.create(root, parent, at, true)
    applier.doneRoot()
    if (newId === null) continue
    created.push(newId)
    i++
  }
  if (parent.type === 'group' && created.length > 0) fitGroups(doc, created, ctx.geometry)
  return { created, parentId: parent.id, replacedId, warnings: applier.w.items }
}
