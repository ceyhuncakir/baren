/**
 * Editor actions shared by the context menu (15), the HTML menu bar commands and the
 * keyboard shortcuts. Each acts on the current selection through the canvas controller
 * (selection, undo, zoom) or @baren/schema helpers (one commit per action).
 *
 * Phase 3 (docs/phase3/contract.md §6–§8): group / ungroup, create component, detach,
 * reset overrides, go to main component (restore a deleted main), insert instances, and the
 * clipboard through `bridge.clipboard` (payload v2 across files and windows, paste in place,
 * paste here). Every structure command takes the canvas geometry (`canvas.geometry()`), so
 * world positions survive rotated parents, groups and flex flow.
 */
import {
  clipAssetBytes,
  clipboardPayloadVersion,
  createComponent,
  createInstance,
  detachInstance,
  docGeometry,
  duplicateNodes,
  findMainComponent,
  getChildIds,
  getNode,
  getNodeType,
  groupNodes,
  isTreeId,
  parseClipboardPayload,
  pasteClipboard,
  placementStyles,
  readRotation,
  removeNodes,
  renderHtml,
  resetOverrides,
  restoreMainComponent,
  serializeClipboard,
  setRotation,
  SchemaError,
  standaloneSvgMarkup,
  toRenderSubtree,
  transact,
  ungroupNodes,
  vectorToSvgMarkup,
  wouldCreateCycleForKeys,
  type ClipboardPayload,
  type GeometrySource,
  type ResolvedNode,
  type StylePatch,
} from '@baren/schema'
import { toast } from '@baren/ui'
import { assetsArrived, drawableAssetUrls, putAsset } from '../../lib/assets'
import { bridge } from '../../lib/bridge'
import { fileLink } from '../collab/account'
import { insertImageFiles, insertSvgMarkup } from '../images/insert'
import { toCss, toJsx } from '../model/css'
import {
  addFlexLayout,
  containerForInsert,
  deleteNodes,
  ORIGIN,
  pageOf,
  pasteText,
  patchStyles,
  realIdOf,
  reorder,
  setFlag,
  wrapInFrame,
} from '../model/docOps'
import { indexAfterSelection, pasteTranslate, type PasteMode } from '../model/pastePlacement'
import type { EditorSession } from '../session/context'
import { canEdit } from '../session/readOnly'
import { renderNodePng } from '../session/raster'
import { selectIds } from '../session/selection'
import { buildCopyContent, copyPng, copyRich, copyText, readClipboard } from './clipboard'

export type CopyAsFormat = 'html' | 'jsx' | 'css' | 'svg' | 'png1' | 'png2' | 'link' | 'agent'

/** Where "Paste here" was asked for (context menu). */
export interface PastePoint {
  world: { x: number; y: number }
  client: { clientX: number; clientY: number } | null
}

const SVG_RE = /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i

/** The selection's component facts (menus, inspector, command enablement). */
export interface SelectionInfo {
  /** Real nodes only (structure commands). */
  real: string[]
  /** Any expanded instance content is selected. */
  virtual: boolean
  groups: string[]
  /** Real instance roots. */
  instances: string[]
  /** Refs that can be reset (instances and virtual nodes). */
  overridable: string[]
}

export class EditorActions {
  /** Takes a getter: the session object is created after its actions. */
  constructor(private readonly getSession: () => EditorSession) {}

  private get session(): EditorSession {
    return this.getSession()
  }

  private get selection(): readonly string[] {
    return this.session.store.getState().selection
  }

  /** The document may be changed here (not a viewer, no version preview); tells a viewer why not. */
  private writable(): boolean {
    return canEdit(this.session)
  }

  /** World geometry from the canvas (measured), falling back to declared styles. */
  geometry(): GeometrySource {
    const canvas = this.session.canvas.current
    return canvas ? canvas.geometry() : docGeometry(this.session.doc, this.session.resolver)
  }

  hasSelection(): boolean {
    return this.selection.length > 0
  }

  /** Facts about `refs` (default: the selection) for menus and command enablement. */
  info(refs: readonly string[] = this.selection): SelectionInfo {
    const { resolver } = this.session
    const out: SelectionInfo = {
      real: [],
      virtual: false,
      groups: [],
      instances: [],
      overridable: [],
    }
    for (const ref of refs) {
      const node = resolver.resolveNode(ref)
      if (!node) continue
      if (!isTreeId(ref)) {
        out.virtual = true
        out.overridable.push(ref)
        continue
      }
      out.real.push(ref)
      if (node.type === 'group') out.groups.push(ref)
      if (node.type === 'instance') {
        out.instances.push(ref)
        out.overridable.push(ref)
      }
    }
    return out
  }

  // --- History & selection -----------------------------------------------------

  undo(): void {
    this.session.canvas.current?.undo()
  }

  redo(): void {
    this.session.canvas.current?.redo()
  }

  selectAll(): void {
    this.session.canvas.current?.selectAll()
  }

  delete(): void {
    if (!this.writable()) return
    const canvas = this.session.canvas.current
    if (canvas) canvas.deleteSelection()
    else deleteNodes(this.session.doc, this.selection, ORIGIN.menu, this.geometry())
  }

  duplicate(): void {
    if (!this.writable()) return
    const canvas = this.session.canvas.current
    if (canvas) {
      canvas.duplicateSelection()
      return
    }
    const ids = duplicateNodes(this.session.doc, this.selection, this.geometry())
    if (ids.length > 0) selectIds(this.session, ids)
  }

  // --- Clipboard -----------------------------------------------------------------

  /** Serialise refs into payload + html + text (null when nothing copyable). */
  private async copyContent(refs: readonly string[]) {
    const { doc, fileId, store, resolver } = this.session
    const payload = serializeClipboard(doc, refs, {
      geo: this.geometry(),
      fileId,
      pageId: store.getState().pageId,
      app: await bridge.app.version().catch(() => ''),
      resolver,
    })
    if (!payload) return null
    const roots = this.topRefs(refs)
    const names = roots.map((ref) => resolver.resolveNode(ref)?.name ?? '').filter((n) => n !== '')
    return buildCopyContent(
      payload,
      (assetUrl, tokens) => renderHtml(doc, roots, { tokens, assetUrl }),
      names.join('\n'),
    )
  }

  /** Topmost refs in selection order (drops descendants of other selected refs). */
  private topRefs(refs: readonly string[]): string[] {
    const set = new Set(refs)
    const { tree } = this.session
    return refs.filter((ref) => !tree.ancestors(ref).some((a) => set.has(a)))
  }

  async copy(): Promise<boolean> {
    try {
      const content = await this.copyContent(this.selection)
      if (!content) return false
      await bridge.clipboard.write({
        text: content.text,
        baren: content.json,
        ...(content.html !== undefined ? { html: content.html } : {}),
      })
      return true
    } catch (error) {
      toast(error instanceof Error ? `Couldn't copy: ${error.message}` : "Couldn't copy")
      return false
    }
  }

  async cut(): Promise<void> {
    if (!this.writable()) return
    const refs = [...this.selection]
    if (refs.length === 0) return
    if (!(await this.copy())) return
    removeNodes(this.session.doc, refs, this.geometry(), { origin: ORIGIN.clipboard })
  }

  /** Ctrl+Shift+V: paste at the exact copied position. */
  pasteInPlace(): Promise<void> {
    return this.paste('inPlace')
  }

  /**
   * Paste nodes (payload v2 / legacy v1), images, SVG markup or text. `mode` decides the
   * placement (contract §7.4); "Paste here" passes the clicked point.
   */
  async paste(mode: PasteMode = 'paste', point: PastePoint | null = null): Promise<void> {
    if (!this.writable()) return
    const clip = await readClipboard()
    const json = clip.baren ?? (clip.text && /^\s*\{/.test(clip.text) ? clip.text : null)
    if (json !== null) {
      const version = clipboardPayloadVersion(json)
      if (version !== null && version > 2) {
        toast('Copied from a newer version of Baren')
        return
      }
      const payload = parseClipboardPayload(json)
      if (payload) {
        await this.pastePayload(payload, mode, point)
        return
      }
    }
    const at = point?.world ?? null
    if (clip.images.length > 0) {
      const files = clip.images.map(
        (img) => new Blob([new Uint8Array(img.bytes)], { type: img.mime }),
      )
      await insertImageFiles(this.session, files, {
        world: at,
        names: files.map(() => 'Pasted image'),
      })
      return
    }
    const svg = clip.svg ?? (clip.text && SVG_RE.test(clip.text) ? clip.text : null)
    if (svg && insertSvgMarkup(this.session, svg, at)) return
    const text = clip.text
    if (!text) return
    const { doc, store } = this.session
    const state = store.getState()
    const parent = at ? state.pageId : containerForInsert(doc, state.selection, state.pageId)
    const id = pasteText(doc, text, parent, at ?? this.viewportCenter())
    if (id) afterFrame(() => selectIds(this.session, [id]))
  }

  private async pastePayload(
    payload: ClipboardPayload,
    mode: PasteMode,
    point: PastePoint | null,
  ): Promise<void> {
    const { doc, store, fileId } = this.session
    const canvas = this.session.canvas.current
    const state = store.getState()
    // Embedded asset bytes go into the local core first (content-addressed, idempotent).
    const assetRemap: Record<string, string> = {}
    const stored: string[] = []
    for (const [hash, asset] of Object.entries(payload.assets)) {
      const bytes = clipAssetBytes(asset)
      if (!bytes) continue
      try {
        const local = await putAsset(bytes, asset.mime ?? 'application/octet-stream')
        stored.push(local)
        if (local !== hash) assetRemap[hash] = local
      } catch {
        // The image shows the missing placeholder until it arrives through sync.
      }
    }
    if (stored.length > 0) {
      assetsArrived(stored)
      canvas?.reloadAssets(stored)
    }
    // Target parent and index.
    let parentId: string
    let index: number | undefined
    if (mode === 'here' && point) {
      const target =
        canvas && point.client ? canvas.dropTargetAt(point.client, { deep: true }) : null
      canvas?.dropTargetAt(null)
      parentId = target?.parentId ?? state.pageId
      index = undefined
    } else {
      parentId = containerForInsert(doc, state.selection, state.pageId)
      index = indexAfterSelection(
        getChildIds(doc, parentId),
        state.selection.map((ref) => realIdOf(ref)),
      )
    }
    const geo = this.geometry()
    const targetFrame = getNodeType(doc, parentId) === 'page' ? null : geo.frameOf(parentId)
    const translate = pasteTranslate({
      mode,
      bounds: payload.bounds,
      sameFile: payload.source.fileId === fileId,
      viewport: this.viewportWorld(),
      target: targetFrame
        ? {
            x: targetFrame.x,
            y: targetFrame.y,
            width: targetFrame.width,
            height: targetFrame.height,
          }
        : null,
      point: point?.world ?? null,
    })
    const result = pasteClipboard(doc, payload, {
      parentId,
      ...(index !== undefined ? { index } : {}),
      translate,
      geo,
      assetRemap,
      origin: ORIGIN.clipboard,
    })
    if (result.refused === 'cycle') {
      toast("Can't paste a component inside itself")
      return
    }
    if (result.refused) {
      toast("Can't paste here")
      return
    }
    if (result.ids.length > 0) afterFrame(() => selectIds(this.session, result.ids))
  }

  /** The visible world rectangle. */
  private viewportWorld(): { x: number; y: number; width: number; height: number } | null {
    const canvas = this.session.canvas.current
    if (!canvas) return null
    const v = canvas.getViewport()
    return { x: v.x, y: v.y, width: v.width / v.zoom, height: v.height / v.zoom }
  }

  private viewportCenter(): { x: number; y: number } | null {
    const canvas = this.session.canvas.current
    if (!canvas) return null
    const v = canvas.getViewport()
    return canvas.screenToCanvas({ x: v.width / 2, y: v.height / 2 })
  }

  async copyAs(format: CopyAsFormat): Promise<void> {
    if (format === 'agent') return this.copyAgentContext()
    const { doc, fileId, resolver } = this.session
    const id = this.topRefs(this.selection)[0]
    if (id === undefined) return
    const node = resolver.resolveNode(id)
    if (!node) return
    try {
      switch (format) {
        case 'html': {
          const content = await this.copyContent([id])
          const html = content?.html ?? renderHtml(doc, [id])
          await copyRich(html, html)
          toast('HTML copied')
          return
        }
        case 'jsx': {
          const sub = toRenderSubtree(doc, id, resolver)
          if (sub) await copyText(toJsx(sub.nodes, id))
          toast('React (JSX) copied')
          return
        }
        case 'css':
          await copyText(toCss(node))
          toast('CSS copied')
          return
        case 'svg':
          if (node.type === 'vector' && node.vector) {
            await copyText(vectorToSvgMarkup(node, this.session.tokens.getSnapshot()))
            toast('SVG copied')
          } else if (node.type === 'svg' && node.svg) {
            await copyText(standaloneSvgMarkup(node.svg))
            toast('SVG copied')
          } else {
            toast('SVG export works for vector and SVG layers.')
          }
          return
        case 'png1':
        case 'png2': {
          const urls = drawableAssetUrls()
          const png = await renderNodePng(doc, id, {
            scale: format === 'png2' ? 2 : 1,
            assetUrl: urls.assetUrl,
          }).finally(() => urls.release())
          const ok = png ? await copyPng(png) : false
          toast(
            ok
              ? `PNG ${format === 'png2' ? '2×' : '1×'} copied`
              : "Couldn't render a PNG of this layer.",
          )
          return
        }
        case 'link': {
          const remoteId = this.session.store.getState().remoteId ?? this.session.file?.remoteId
          if (!remoteId) {
            toast('Sign in and add this file to a team to get a link.')
            return
          }
          await copyText(fileLink(remoteId, id))
          toast('Link copied')
          return
        }
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Copy failed')
    }
  }

  /**
   * Copy as → Agent context: every selected layer as text for a coding agent's prompt, with
   * the ids the Baren MCP tools take (agent/selectionContext.ts, loaded on first use).
   */
  private async copyAgentContext(): Promise<void> {
    const refs = this.topRefs(this.selection)
    if (refs.length === 0) return
    const { doc, resolver, fileId, canvas } = this.session
    try {
      const { selectionContext } = await import('../../agent/selectionContext')
      const text = selectionContext({
        ctx: { doc, resolver },
        refs,
        fileId,
        fileName: this.session.docName.getSnapshot() || this.session.file?.name || 'Untitled',
        frameOf: (ref) => canvas.current?.getNodeFrame(ref) ?? null,
      })
      const ok = await copyText(text)
      toast(
        !ok
          ? "Couldn't copy to the clipboard"
          : refs.length === 1
            ? 'Agent context copied'
            : `Agent context of ${refs.length} layers copied`,
      )
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Copy failed')
    }
  }

  // --- Structure -----------------------------------------------------------------

  addFlex(): void {
    if (!this.writable()) return
    addFlexLayout(this.session.doc, this.info().real)
  }

  wrapInFrame(): void {
    if (!this.writable()) return
    const id = wrapInFrame(this.session.doc, this.info().real, this.geometry())
    if (id) afterFrame(() => selectIds(this.session, [id]))
  }

  /** Ctrl+G: one undo step; the new group is selected. */
  group(): string | null {
    if (!this.writable()) return null
    const { real, virtual } = this.info()
    if (real.length === 0 || virtual) return null
    const id = groupNodes(this.session.doc, real, this.geometry(), { origin: ORIGIN.group })
    if (id) selectIds(this.session, [id])
    return id
  }

  /** Ctrl+Shift+G: the former children stay selected. */
  ungroup(): string[] {
    if (!this.writable()) return []
    const { groups } = this.info()
    if (groups.length === 0) return []
    const children = ungroupNodes(this.session.doc, groups, this.geometry(), {
      origin: ORIGIN.ungroup,
    })
    selectIds(this.session, children)
    return children
  }

  /** Ctrl+Alt+K: a selected frame becomes a main; anything else is wrapped first. */
  createComponent(): string | null {
    if (!this.writable()) return null
    const { real, virtual } = this.info()
    if (real.length === 0 || virtual) return null
    try {
      const id = createComponent(this.session.doc, real, this.geometry(), {
        origin: ORIGIN.component,
      })
      if (id) selectIds(this.session, [id])
      return id
    } catch (error) {
      toast(cycleMessage(error) ?? "Couldn't create a component")
      return null
    }
  }

  /** Ctrl+Alt+B: instances become frames with real children (same ids). */
  detachInstance(): string[] {
    if (!this.writable()) return []
    const { instances } = this.info()
    if (instances.length === 0) return []
    const { doc } = this.session
    transact(
      doc,
      () => {
        for (const id of instances) detachInstance(doc, id)
      },
      { origin: ORIGIN.detach },
    )
    selectIds(this.session, instances)
    return instances
  }

  /** Clear the selected instances' overrides (or a virtual node's, with what is below it). */
  resetOverrides(): void {
    if (!this.writable()) return
    const { overridable } = this.info()
    if (overridable.length === 0) return
    const { doc } = this.session
    transact(
      doc,
      () => {
        for (const ref of overridable) resetOverrides(doc, ref, { deep: !isTreeId(ref) })
      },
      { origin: ORIGIN.resetOverrides },
    )
  }

  /**
   * Switch to the main component of the selected instance (or of the component a virtual node
   * comes from), select it and zoom to it. A deleted main offers Restore.
   */
  goToMainComponent(ref: string | undefined = this.selection[0]): void {
    if (ref === undefined) return
    const { doc, resolver } = this.session
    const node = resolver.resolveNode(ref)
    if (!node) return
    let key: string | undefined
    let hint: string | undefined
    let target: string | undefined
    if (node.type === 'instance') {
      key = node.componentKey
      hint = node.mainId
    } else if (node.source) {
      key = node.source.componentKey
      target = node.source.mainNodeId
    } else if (node.type === 'frame' && node.componentKey) {
      key = node.componentKey
    }
    if (!key) return
    const found = findMainComponent(doc, key, hint)
    if (!found) {
      toast('Component not found')
      return
    }
    if (found.deleted) {
      const componentKey = key
      toast('The main component was deleted.', {
        actionLabel: 'Restore',
        onAction: () => this.restoreMainComponent(componentKey),
      })
      return
    }
    const select = target && getNode(doc, target) ? target : found.mainId
    this.reveal(select)
  }

  /** Re-create a deleted main on the "Components" page and go there. */
  restoreMainComponent(key: string): string | null {
    if (!this.writable()) return null
    const id = restoreMainComponent(this.session.doc, key, { origin: ORIGIN.component })
    if (id) this.reveal(id)
    else toast('Component not found')
    return id
  }

  /** Select `id` on its page (switching pages first) and zoom to it; a page: fit it. */
  reveal(id: string): void {
    const { doc, store } = this.session
    const page = pageOf(doc, realIdOf(id))
    if (page === null) return
    const finish = () => {
      const canvas = this.session.canvas.current
      if (!canvas) return
      if (id === page) return canvas.zoomToFit({ animate: false })
      canvas.select([id])
      canvas.zoomToSelection({ animate: false })
    }
    if (store.getState().pageId !== page) {
      store.setState({ pageId: page, selection: [], hoveredId: null })
      // The canvas switches pages from React's effect: wait for it to mount the page.
      afterFrame(() => afterFrame(finish))
    } else finish()
  }

  /**
   * Insert an instance of `key`. With `drop` (a client point from a drag onto the canvas) it
   * lands in the deepest frame under the point (cycles refused); otherwise at the viewport
   * centre inside `containerForInsert`. The instance keeps the main's size.
   */
  insertInstance(
    key: string,
    drop: { clientX: number; clientY: number } | null = null,
  ): string | null {
    if (!this.writable()) return null
    const { doc, store, resolver } = this.session
    const canvas = this.session.canvas.current
    const found = findMainComponent(doc, key)
    if (!found) {
      toast('Component not found')
      return null
    }
    const geo = this.geometry()
    const declared = docGeometry(doc, resolver)
    const main = canvas?.getNodeFrame(found.mainId) ?? declared.frameOf(found.mainId)
    const width = main?.width && main.width > 0 ? main.width : 100
    const height = main?.height && main.height > 0 ? main.height : 100
    const accept = (parentId: string) => !wouldCreateCycleForKeys(doc, [key], parentId)
    let parentId: string
    let index: number | undefined
    let styles: StylePatch
    if (drop && canvas) {
      const target = canvas.dropTargetAt(drop, { deep: true, accept })
      canvas.dropTargetAt(null)
      if (!target) return null
      const placed = target.place({
        x: target.world.x - width / 2,
        y: target.world.y - height / 2,
        width,
        height,
      })
      parentId = target.parentId
      index = placed.index
      styles = { ...placed.styles }
    } else {
      const state = store.getState()
      parentId = containerForInsert(doc, state.selection, state.pageId)
      if (!accept(parentId)) parentId = state.pageId
      const centre = this.viewportCenter() ?? { x: 0, y: 0 }
      const world = {
        x: Math.round(centre.x - width / 2),
        y: Math.round(centre.y - height / 2),
        width,
        height,
        rotation: 0,
      }
      const parentFrame = getNodeType(doc, parentId) === 'page' ? null : geo.frameOf(parentId)
      styles = placementStyles(doc, parentId, world, parentFrame)
      index = indexAfterSelection(
        getChildIds(doc, parentId),
        state.selection.map((ref) => realIdOf(ref)),
      )
    }
    // New instances follow the main's size (contract §6): drop the placement's size keys.
    delete styles['width']
    delete styles['height']
    for (const k of Object.keys(styles)) if (styles[k] === null) delete styles[k]
    try {
      const id = createInstance(
        doc,
        {
          componentKey: key,
          parentId,
          ...(index !== undefined ? { index } : {}),
          styles: styles as Record<string, string | number>,
        },
        { origin: ORIGIN.insert },
      )
      afterFrame(() => selectIds(this.session, [id]))
      return id
    } catch (error) {
      toast(cycleMessage(error) ?? "Couldn't insert the component")
      return null
    }
  }

  bringToFront(): void {
    if (!this.writable()) return
    reorder(this.session.doc, this.info().real, 'front')
  }

  sendToBack(): void {
    if (!this.writable()) return
    reorder(this.session.doc, this.info().real, 'back')
  }

  rename(): void {
    if (!this.writable()) return
    const id = this.selection[0]
    if (id === undefined || !isTreeId(id)) return
    this.session.store.setState({ renamingId: id, mode: 'design', leftPanelOpen: true })
  }

  toggleLock(): void {
    if (!this.writable()) return
    const { doc, resolver } = this.session
    const ids = this.info().real
    const allLocked = ids.length > 0 && ids.every((id) => resolver.resolveNode(id)?.locked === true)
    setFlag(doc, ids, 'locked', !allLocked)
  }

  toggleHide(): void {
    if (!this.writable()) return
    const { doc, resolver } = this.session
    const ids = this.selection
    const allHidden = ids.length > 0 && ids.every((id) => resolver.resolveNode(id)?.hidden === true)
    setFlag(doc, ids, 'hidden', !allHidden)
  }

  toggleClip(): void {
    if (!this.writable()) return
    const { doc, resolver } = this.session
    const frames = this.selection.filter((id) => {
      const t = resolver.resolveNode(id)?.type
      return t === 'frame' || t === 'instance'
    })
    const clipped = frames.every((id) => {
      const o = resolver.resolveNode(id)?.styles['overflow']
      return o === 'hidden' || o === 'clip'
    })
    patchStyles(doc, frames, () => ({ overflow: clipped ? null : 'hidden' }))
  }

  /** Rotate each selected layer by 90° about its own centre (Layout menu). */
  rotate90(): void {
    if (!this.writable()) return
    const { doc, resolver } = this.session
    const geo = this.geometry()
    const refs = this.selection
    if (refs.length === 0) return
    transact(
      doc,
      () => {
        for (const ref of refs) {
          const node: ResolvedNode | undefined = resolver.resolveNode(ref)
          if (!node || node.type === 'page') continue
          setRotation(doc, [ref], readRotation(node.styles) + 90, geo)
        }
      },
      { origin: ORIGIN.inspector },
    )
  }

  // --- View ----------------------------------------------------------------------

  zoomIn(): void {
    this.session.canvas.current?.zoomIn()
  }

  zoomOut(): void {
    this.session.canvas.current?.zoomOut()
  }

  zoomToFit(): void {
    this.session.canvas.current?.zoomToFit()
  }

  zoom100(): void {
    this.session.canvas.current?.zoomTo(1)
  }

  zoomToSelection(): void {
    this.session.canvas.current?.zoomToSelection()
  }
}

/** After the next frame (the canvas has rendered new nodes); a timer outside browsers. */
function afterFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn)
  else setTimeout(fn, 0)
}

function cycleMessage(error: unknown): string | null {
  return error instanceof SchemaError && error.code === 'cycle'
    ? "Can't put a component inside itself"
    : null
}
