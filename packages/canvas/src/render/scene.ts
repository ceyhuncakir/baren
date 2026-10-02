import {
  assetRefsInValue,
  vectorToPathD,
  type DesignNode,
  type NodeType,
  type StyleValue,
  type Styles,
  type VectorData,
} from '@baren/schema'
import type { AssetUrlCache } from './assets.ts'
import type { SvgCache } from './sanitizeSvg.ts'
import {
  cssPropertyName,
  hasAssetStyles,
  isPaintOnlyKey,
  pxValue,
  renderValue,
  stylesToCssText,
  type AssetCssRewrite,
} from './styles.ts'

/** The DOM element that renders one design node. */
export type NodeElement = HTMLElement | SVGSVGElement

/** A rendered design node: its mirrored data plus its element. */
export interface SceneNode extends SceneNodeData {
  el: NodeElement
}

export interface SceneNodeData {
  id: string
  type: NodeType
  parentId: string | null
  children: string[]
  styles: Styles
  name: string
  text?: string
  svg?: string
  assetId?: string
  vector?: VectorData
  /** Main components (frames) and instances. */
  componentKey?: string
  hidden: boolean
  locked: boolean
}

export interface RenderContext {
  svgCache: SvgCache
  assets: AssetUrlCache
  /** `assets.rewriteCss`, bound once (image fills in background values). */
  rewrite: AssetCssRewrite
  /** Image layer elements whose `src` is still loading (pending work). */
  loadingImages: Set<HTMLImageElement>
  /** An image layer finished loading or failed (its box may depend on the natural size). */
  imageSettled(nodeId: string): void
}

/** Style keys handled by the top-level wrapper (world position), not the node element. */
export const TOP_LEVEL_OMIT: ReadonlySet<string> = new Set([
  'left',
  'top',
  'right',
  'bottom',
  'inset',
  'position',
])

export const NODE_ID_ATTR = 'data-nid'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Ids of expanded instance content contain '/' (`"<instanceId>/<path>"`); TreeIDs never do. */
export function isVirtualRef(id: string): boolean {
  return id.includes('/')
}

/** The `<path>` of a vector element (its only child). */
function vectorPath(el: NodeElement): SVGPathElement | null {
  const first = el.firstElementChild
  return first instanceof SVGPathElement ? first : null
}

/** Size attributes and viewBox of a vector `<svg>` from its px width/height (contract 3.1). */
function applyVectorBox(el: NodeElement, styles: Styles): void {
  const w = pxValue(styles['width']) ?? 0
  const h = pxValue(styles['height']) ?? 0
  el.setAttribute('width', String(w))
  el.setAttribute('height', String(h))
  el.setAttribute('viewBox', `0 0 ${w} ${h}`)
  if (styles['overflow'] === undefined) el.setAttribute('overflow', 'visible')
  else el.removeAttribute('overflow')
}

/** Path data and fill rule of a vector element. */
export function applyVectorPath(el: NodeElement, vector: VectorData | undefined): void {
  const path = vectorPath(el)
  if (!path) return
  const v = vector ?? { fillRule: 'nonzero', subpaths: [] }
  path.setAttribute('d', vectorToPathD(v))
  path.setAttribute('fill-rule', v.fillRule)
}

function applyAllStyles(
  el: NodeElement,
  styles: Styles,
  omit: ReadonlySet<string> | undefined,
  extra: string,
  rewrite: AssetCssRewrite,
): void {
  if (el instanceof SVGElement) {
    for (const key in styles) {
      if (omit?.has(key)) continue
      setStyle(el, key, styles[key], rewrite)
    }
    if (extra) el.style.cssText += extra
    return
  }
  const css = stylesToCssText(styles, omit, rewrite)
  if (css !== null) {
    el.style.cssText = css + extra
    return
  }
  el.style.cssText = extra
  for (const key in styles) {
    if (omit?.has(key)) continue
    setStyle(el, key, styles[key], rewrite)
  }
}

function setStyle(
  el: NodeElement,
  key: string,
  value: StyleValue | undefined,
  rewrite: AssetCssRewrite,
): void {
  const name = cssPropertyName(key)
  if (name === null) return
  if (value === undefined) el.style.removeProperty(name)
  else el.style.setProperty(name, renderValue(key, value, rewrite))
}

/**
 * One top-level node (artboard) and its subtree, rendered as real DOM.
 * All methods write DOM; callers run them in the frame's write phase.
 */
export class Scene {
  readonly nodes = new Map<string, SceneNode>()
  readonly root: SceneNode

  private constructor(
    readonly topId: string,
    private readonly ctx: RenderContext,
    snapshot: Record<string, DesignNode>,
  ) {
    const rootNode = snapshot[topId]
    if (!rootNode) throw new Error(`Scene root ${topId} missing from snapshot`)
    this.root = this.build(rootNode, snapshot)
  }

  static fromSnapshot(
    topId: string,
    snapshot: Record<string, DesignNode>,
    ctx: RenderContext,
  ): Scene {
    return new Scene(topId, ctx, snapshot)
  }

  get size(): number {
    return this.nodes.size
  }

  get rootEl(): NodeElement {
    return this.root.el
  }

  /** Iterative build: create elements for `node` and its descendants found in `snapshot`. */
  private build(node: DesignNode, snapshot: Record<string, DesignNode>): SceneNode {
    const top = this.createSceneNode(node)
    const stack: SceneNode[] = [top]
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      const parentEl = cur.el
      const childIds = cur.children
      const frag = childIds.length > 1 ? document.createDocumentFragment() : null
      for (const childId of childIds) {
        const child = snapshot[childId]
        if (!child) continue
        const sn = this.createSceneNode(child)
        ;(frag ?? parentEl).appendChild(sn.el)
        if (sn.children.length > 0) stack.push(sn)
      }
      if (frag) parentEl.appendChild(frag)
      // Drop ids that were missing from the snapshot so the mirror stays consistent.
      if (childIds.some((id) => !this.nodes.has(id)))
        cur.children = childIds.filter((id) => this.nodes.has(id))
    }
    return top
  }

  private createSceneNode(node: DesignNode): SceneNode {
    const data: SceneNodeData = {
      id: node.id,
      type: node.type,
      parentId: node.parentId,
      children: [...node.children],
      styles: { ...node.styles },
      name: node.name,
      hidden: node.hidden === true,
      locked: node.locked === true,
    }
    if (node.text !== undefined) data.text = node.text
    if (node.svg !== undefined) data.svg = node.svg
    if (node.assetId !== undefined) data.assetId = node.assetId
    if (node.vector !== undefined) data.vector = node.vector
    if (node.componentKey !== undefined) data.componentKey = node.componentKey
    // Same object: async image loads compare against the node's current assetId.
    const sn: SceneNode = Object.assign(data, { el: this.createElement(data) })
    this.nodes.set(sn.id, sn)
    return sn
  }

  private createElement(sn: SceneNodeData): NodeElement {
    let el: NodeElement
    switch (sn.type) {
      case 'text': {
        const div = document.createElement('div')
        div.className = 'ic-node ic-text'
        div.textContent = sn.text ?? ''
        el = div
        break
      }
      case 'svg': {
        const svg =
          (sn.svg && this.ctx.svgCache.get(sn.svg)) ||
          document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.classList.add('ic-node')
        el = svg
        break
      }
      case 'image':
        el = this.createImage(sn)
        break
      case 'vector': {
        const svg = document.createElementNS(SVG_NS, 'svg')
        svg.setAttribute('class', 'ic-node ic-vector')
        svg.appendChild(document.createElementNS(SVG_NS, 'path'))
        applyVectorPath(svg, sn.vector)
        el = svg
        break
      }
      case 'group': {
        const div = document.createElement('div')
        div.className = 'ic-node ic-group'
        el = div
        break
      }
      default: {
        const div = document.createElement('div')
        div.className = 'ic-node'
        el = div
      }
    }
    el.setAttribute(NODE_ID_ATTR, sn.id)
    this.applyStyles(sn, el)
    if (sn.type === 'vector') applyVectorBox(el, sn.styles)
    if (sn.hidden) el.classList.add('ic-hidden')
    return el
  }

  /**
   * An image layer: `<img decoding=async>` whose `src` comes from the asset resolver. A
   * missing asset (unknown hash, failed load) shows the neutral placeholder
   * (`.ic-img-missing`) until the asset arrives and the host reloads it.
   */
  private createImage(sn: SceneNodeData): HTMLImageElement {
    const img = document.createElement('img')
    img.className = 'ic-node ic-img'
    img.alt = ''
    img.draggable = false
    img.decoding = 'async'
    const assetId = sn.assetId
    const ctx = this.ctx
    if (!assetId) {
      img.classList.add('ic-img-missing')
      return img
    }
    const settle = (ok: boolean) => {
      ctx.loadingImages.delete(img)
      img.classList.toggle('ic-img-missing', !ok)
      if (!ok) {
        img.removeAttribute('src')
        ctx.assets.markFailed(assetId)
      }
      ctx.imageSettled(sn.id)
    }
    img.addEventListener('load', () => settle(true))
    img.addEventListener('error', () => {
      if (img.hasAttribute('src')) settle(false)
    })
    ctx.assets.resolve(assetId, (url) => {
      if (sn.assetId !== assetId) return
      if (!url) {
        img.classList.add('ic-img-missing')
        return
      }
      ctx.loadingImages.add(img)
      img.src = url
    })
    return img
  }

  private applyStyles(sn: SceneNodeData, el: NodeElement): void {
    const isTop = sn.id === this.topId
    applyAllStyles(
      el,
      sn.styles,
      isTop ? TOP_LEVEL_OMIT : undefined,
      isTop ? 'position:relative;' : '',
      this.ctx.rewrite,
    )
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /** Insert `node` (without children) under `parentId` at `index`. */
  insert(node: DesignNode, parentId: string, index: number): SceneNode | null {
    const parent = this.nodes.get(parentId)
    if (!parent || this.nodes.has(node.id)) return null
    const sn = this.createSceneNode({ ...node, parentId, children: [] })
    this.attachChild(parent, sn, index)
    return sn
  }

  /** Insert a whole subtree snapshot (used when a node moves in from another artboard). */
  insertSubtree(
    rootId: string,
    snapshot: Record<string, DesignNode>,
    parentId: string,
    index: number,
  ): void {
    const parent = this.nodes.get(parentId)
    const node = snapshot[rootId]
    if (!parent || !node || this.nodes.has(rootId)) return
    const sn = this.build({ ...node, parentId }, snapshot)
    this.attachChild(parent, sn, index)
  }

  private attachChild(parent: SceneNode, sn: SceneNode, index: number): void {
    const i = Math.max(0, Math.min(index, parent.children.length))
    const before = parent.children[i]
    const beforeEl = before !== undefined ? (this.nodes.get(before)?.el ?? null) : null
    parent.children.splice(i, 0, sn.id)
    sn.parentId = parent.id
    parent.el.insertBefore(sn.el, beforeEl)
  }

  /** Remove a node and its subtree. Returns the removed ids. */
  remove(id: string): string[] {
    const sn = this.nodes.get(id)
    if (!sn || id === this.topId) return []
    const parent = sn.parentId !== null ? this.nodes.get(sn.parentId) : undefined
    if (parent) parent.children = parent.children.filter((c) => c !== id)
    sn.el.remove()
    const removed: string[] = []
    const stack = [sn]
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      removed.push(cur.id)
      this.nodes.delete(cur.id)
      for (const c of cur.children) {
        const child = this.nodes.get(c)
        if (child) stack.push(child)
      }
    }
    return removed
  }

  /** Move a node within this scene; `index` is its final position among the new siblings. */
  move(id: string, parentId: string, index: number): boolean {
    const sn = this.nodes.get(id)
    const parent = this.nodes.get(parentId)
    if (!sn || !parent || id === this.topId) return false
    const old = sn.parentId !== null ? this.nodes.get(sn.parentId) : undefined
    if (old) old.children = old.children.filter((c) => c !== id)
    sn.el.remove()
    this.attachChild(parent, sn, index)
    return true
  }

  /**
   * Bring a node's styles to `next` (its complete resolved style map): writes only the keys
   * that differ. `layout` tells whether any of them can move or resize boxes. `null` when the
   * node is not in this scene. (The style-only propagation fast path.)
   */
  patchStyles(id: string, next: Readonly<Record<string, StyleValue>>): { layout: boolean } | null {
    const sn = this.nodes.get(id)
    if (!sn) return null
    let values: Record<string, StyleValue | undefined> | null = null
    let layout = false
    for (const k in sn.styles) {
      if (!(k in next)) {
        ;(values ??= {})[k] = undefined
        if (!isPaintOnlyKey(k)) layout = true
      }
    }
    for (const k in next) {
      const v = next[k] as StyleValue
      if (sn.styles[k] !== v) {
        ;(values ??= {})[k] = v
        if (!isPaintOnlyKey(k)) layout = true
      }
    }
    if (values) this.setStyles(id, values)
    return { layout }
  }

  setStyles(id: string, values: Record<string, StyleValue | undefined>): void {
    const sn = this.nodes.get(id)
    if (!sn) return
    const isTop = id === this.topId
    let box = false
    for (const key in values) {
      const v = values[key]
      if (v === undefined) delete sn.styles[key]
      else sn.styles[key] = v
      if (key === 'width' || key === 'height' || key === 'overflow') box = true
      if (isTop && TOP_LEVEL_OMIT.has(key)) continue
      setStyle(sn.el, key, v, this.ctx.rewrite)
    }
    if (box && sn.type === 'vector') applyVectorBox(sn.el, sn.styles)
  }

  /** New path geometry for a vector node. */
  setVector(id: string, vector: VectorData | undefined): void {
    const sn = this.nodes.get(id)
    if (!sn || sn.type !== 'vector') return
    if (vector) sn.vector = vector
    else delete sn.vector
    applyVectorPath(sn.el, vector)
  }

  setText(id: string, text: string, skipDom = false): void {
    const sn = this.nodes.get(id)
    if (!sn || sn.type !== 'text') return
    sn.text = text
    if (!skipDom && sn.el.textContent !== text) sn.el.textContent = text
  }

  setProps(id: string, props: Record<string, unknown>): void {
    const sn = this.nodes.get(id)
    if (!sn) return
    for (const key in props) {
      const v = props[key]
      switch (key) {
        case 'name':
          sn.name = typeof v === 'string' ? v : ''
          break
        case 'hidden':
          sn.hidden = v === true
          sn.el.classList.toggle('ic-hidden', sn.hidden)
          break
        case 'locked':
          sn.locked = v === true
          break
        case 'svg':
          if (typeof v === 'string') sn.svg = v
          else delete sn.svg
          if (sn.type === 'svg') this.replaceElement(sn)
          break
        case 'assetId':
          if (typeof v === 'string') sn.assetId = v
          else delete sn.assetId
          if (sn.type === 'image') this.replaceElement(sn)
          break
        case 'type':
          if (typeof v === 'string' && v !== sn.type) {
            sn.type = v as NodeType
            this.replaceElement(sn)
          }
          break
        case 'componentKey':
          if (typeof v === 'string') sn.componentKey = v
          else delete sn.componentKey
          break
        default:
          break
      }
    }
  }

  /** Re-create a node's element (svg markup / image / type change), keeping its children. */
  private replaceElement(sn: SceneNode): void {
    const old = sn.el
    if (old instanceof HTMLImageElement) this.ctx.loadingImages.delete(old)
    const fresh = this.createElement(sn)
    while (old.firstChild && sn.children.length > 0) fresh.appendChild(old.firstChild)
    old.replaceWith(fresh)
    sn.el = fresh
  }

  /**
   * Re-render what references `ids` after their asset state changed (resolved, failed,
   * reloaded): image fills re-resolve their URLs; on `reload` image layers get a fresh
   * element (a new request). Returns true when something was re-rendered.
   */
  refreshAssets(ids: ReadonlySet<string>, reload: boolean): boolean {
    let changed = false
    for (const sn of this.nodes.values()) {
      // Image layers follow their own resolution; only a reload needs a fresh request.
      if (reload && sn.type === 'image' && sn.assetId !== undefined && ids.has(sn.assetId)) {
        this.replaceElement(sn)
        changed = true
      }
      if (!hasAssetStyles(sn.styles)) continue
      const isTop = sn.id === this.topId
      for (const key of ['backgroundImage', 'background'] as const) {
        const v = sn.styles[key]
        if (typeof v !== 'string') continue
        if (!assetRefsInValue(v).some((h) => ids.has(h))) continue
        if (isTop && TOP_LEVEL_OMIT.has(key)) continue
        setStyle(sn.el, key, v, this.ctx.rewrite)
        changed = true
      }
    }
    return changed
  }

  /**
   * Bring the subtree under `rootId` in line with `snapshot` (an instance re-expanded after its
   * main or overrides changed): unchanged structure is patched in place (only differing style
   * keys, text and props are written); where the children of a node differ they are rebuilt.
   * Returns the ids added and removed. `skipText(id)` keeps the DOM text of a node being edited.
   */
  syncSubtree(
    rootId: string,
    snapshot: Record<string, DesignNode>,
    skipText: (id: string) => boolean,
  ): { added: string[]; removed: string[]; layout: boolean } {
    const added: string[] = []
    const removed: string[] = []
    let layout = false
    const stack = [rootId]
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      const sn = this.nodes.get(id)
      const next = snapshot[id]
      if (!sn || !next) continue
      if (sn.type !== next.type && id !== rootId) {
        // Type changed (e.g. a nested instance became unresolved): rebuild below the parent.
        const parent = sn.parentId !== null ? this.nodes.get(sn.parentId) : undefined
        if (parent) {
          this.rebuildChildren(parent, snapshot, added, removed)
          layout = true
          continue
        }
      }
      if (this.patchNode(sn, next, skipText(id))) layout = true
      if (sameIds(sn.children, next.children)) {
        for (let i = sn.children.length - 1; i >= 0; i--) stack.push(sn.children[i] as string)
      } else {
        const kept = this.reconcileChildren(sn, snapshot, added, removed)
        for (let i = kept.length - 1; i >= 0; i--) stack.push(kept[i] as string)
        layout = true
      }
    }
    return { added, removed, layout }
  }

  /**
   * Bring `sn`'s children in line with the snapshot: children that are still there keep
   * their elements (returned, for the caller to patch), gone ones are removed and only new
   * ones are built. A node added to a main thus adds one element per instance instead of
   * rebuilding every instance's content.
   */
  private reconcileChildren(
    sn: SceneNode,
    snapshot: Record<string, DesignNode>,
    added: string[],
    removed: string[],
  ): string[] {
    const next = snapshot[sn.id]
    if (!next) return []
    const want = new Set(next.children.filter((c) => snapshot[c] !== undefined))
    for (const c of [...sn.children]) if (!want.has(c)) removed.push(...this.remove(c))
    const kept: string[] = []
    let i = 0
    for (const childId of next.children) {
      const child = snapshot[childId]
      if (!child) continue
      const existing = this.nodes.get(childId)
      if (existing && existing.parentId === sn.id && existing.type === child.type) {
        if (sn.children[i] !== childId) this.move(childId, sn.id, i)
        kept.push(childId)
        i++
        continue
      }
      // New here: drop any element still rendering one of its nodes elsewhere (a move).
      const st = [childId]
      for (let cur = st.pop(); cur !== undefined; cur = st.pop()) {
        if (this.nodes.has(cur)) removed.push(...this.remove(cur))
        else st.push(...(snapshot[cur]?.children ?? []))
      }
      const built = this.build({ ...child, parentId: sn.id }, snapshot)
      this.attachChild(sn, built, i)
      const walk = [built]
      for (let cur = walk.pop(); cur !== undefined; cur = walk.pop()) {
        added.push(cur.id)
        for (const k of cur.children) {
          const kn = this.nodes.get(k)
          if (kn) walk.push(kn)
        }
      }
      i++
    }
    return kept
  }

  private rebuildChildren(
    sn: SceneNode,
    snapshot: Record<string, DesignNode>,
    added: string[],
    removed: string[],
  ): void {
    for (const c of [...sn.children]) removed.push(...this.remove(c))
    const next = snapshot[sn.id]
    if (!next) return
    next.children.forEach((childId, i) => {
      const child = snapshot[childId]
      if (!child || this.nodes.has(childId)) return
      const before = this.nodes.size
      const built = this.build({ ...child, parentId: sn.id }, snapshot)
      this.attachChild(sn, built, i)
      if (this.nodes.size > before) {
        const st = [built]
        for (let cur = st.pop(); cur !== undefined; cur = st.pop()) {
          added.push(cur.id)
          for (const k of cur.children) {
            const kn = this.nodes.get(k)
            if (kn) st.push(kn)
          }
        }
      }
    })
  }

  /**
   * Write the differences between a rendered node and its new data. Returns true when the
   * change can move or resize boxes (anything beyond paint-only styles and the name).
   */
  private patchNode(sn: SceneNode, next: DesignNode, skipText: boolean): boolean {
    const values: Record<string, StyleValue | undefined> = {}
    let changed = false
    let layout = false
    for (const k in sn.styles) {
      if (!(k in next.styles)) {
        values[k] = undefined
        changed = true
        if (!isPaintOnlyKey(k)) layout = true
      }
    }
    for (const k in next.styles) {
      const v = next.styles[k]
      if (sn.styles[k] !== v) {
        values[k] = v
        changed = true
        if (!isPaintOnlyKey(k)) layout = true
      }
    }
    if (changed) this.setStyles(sn.id, values)
    if (next.type === 'text' && (next.text ?? '') !== (sn.text ?? '')) {
      this.setText(sn.id, next.text ?? '', skipText)
      layout = true
    }
    const props: Record<string, unknown> = {}
    let propsChanged = false
    if ((next.hidden === true) !== sn.hidden) {
      props['hidden'] = next.hidden === true
      propsChanged = true
    }
    if ((next.locked === true) !== sn.locked) {
      props['locked'] = next.locked === true
      propsChanged = true
    }
    if (next.name !== sn.name) {
      props['name'] = next.name
      propsChanged = true
    }
    if (next.svg !== sn.svg) {
      props['svg'] = next.svg
      propsChanged = true
    }
    if (next.assetId !== sn.assetId) {
      props['assetId'] = next.assetId
      propsChanged = true
    }
    if (next.componentKey !== sn.componentKey) {
      props['componentKey'] = next.componentKey
      propsChanged = true
    }
    if (propsChanged) {
      this.setProps(sn.id, props)
      if (Object.keys(props).some((k) => k !== 'name')) layout = true
    }
    if (sn.type === 'vector' && next.vector !== sn.vector) {
      if (JSON.stringify(next.vector) !== JSON.stringify(sn.vector)) {
        this.setVector(sn.id, next.vector)
        layout = true
      } else if (next.vector) sn.vector = next.vector
    }
    return layout
  }

  /** Stop tracking image loads of this scene (it is being disposed). */
  releaseImages(): void {
    for (const sn of this.nodes.values())
      if (sn.el instanceof HTMLImageElement) this.ctx.loadingImages.delete(sn.el)
  }

  /** Nodes in paint (pre-)order. */
  *preorder(): Generator<SceneNode> {
    const stack: SceneNode[] = [this.root]
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      yield cur
      for (let i = cur.children.length - 1; i >= 0; i--) {
        const child = this.nodes.get(cur.children[i] as string)
        if (child) stack.push(child)
      }
    }
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
