/**
 * Test helpers: a document with a page, an ApplyContext with a fake asset map and a simple
 * placement rule, `write()` (parse + apply inside one transaction, like the runtime) and a
 * compact tree view for assertions.
 */
import type { LoroDoc } from 'loro-crdt'
import {
  createComponentResolver,
  createEmptyDoc,
  docGeometry,
  getChildIds,
  getNode,
  getTokens,
  setTokens,
  toRenderSubtree,
  transact,
  type DesignNode,
  type Styles,
  type Token,
} from '@baren/schema'
import { checkInvariants } from '../../schema/tests/invariants.ts'
import {
  applyHtml,
  canonicalStyles,
  parseHtml,
  type ApplyContext,
  type ApplyResult,
  type ResolvedImage,
} from '../src/index.ts'

export { checkInvariants }

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)

export function seeded(seed = 1): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export function setup(tokens: Record<string, Token> = {}): { doc: LoroDoc; pageId: string } {
  const doc = createEmptyDoc('Test', { peerId: 1 })
  if (Object.keys(tokens).length > 0) setTokens(doc, tokens)
  return { doc, pageId: getChildIds(doc, null)[0] as string }
}

/** Sources the fake "main process" resolved. */
export const IMAGES: Record<string, ResolvedImage | { error: string }> = {
  '/Users/ana/brand/logo.png': {
    kind: 'raster',
    hash: HASH_A,
    mime: 'image/png',
    name: 'logo',
    width: 200,
    height: 100,
  },
  'https://example.com/photo.jpg': {
    kind: 'raster',
    hash: HASH_B,
    mime: 'image/jpeg',
    name: 'photo',
    width: 1200,
    height: 800,
  },
  'file:///Users/ana/hero.png': {
    kind: 'raster',
    hash: HASH_A,
    mime: 'image/png',
    name: 'hero',
    width: 640,
    height: 480,
  },
  '/Users/ana/icon.svg': {
    kind: 'svg',
    markup:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><script>alert(1)</script><rect width="32" height="16"/></svg>',
    name: 'icon',
  },
  '/missing.png': { error: 'not_found' },
  'data:image/png;base64,iVBORw0KGgo=': {
    kind: 'raster',
    hash: HASH_B,
    mime: 'image/png',
    name: 'image',
    width: 1,
    height: 1,
  },
}

export function context(doc: LoroDoc, extra: Partial<ApplyContext> = {}): ApplyContext {
  const placed: { left: number; top: number }[] = []
  return {
    fileId: 'file-1',
    geometry: docGeometry(doc),
    resolver: createComponentResolver(doc),
    tokens: getTokens(doc),
    image: (src) => IMAGES[src] ?? null,
    placeArtboard: (pageId, size) => {
      // Simple deterministic rule for tests: a row to the right of every top-level node.
      let right = -80
      for (const id of getChildIds(doc, pageId)) {
        const n = getNode(doc, id)
        const l = Number.parseFloat(String(n?.styles['left'] ?? 0))
        const w = Number.parseFloat(String(n?.styles['width'] ?? 0))
        if (Number.isFinite(l + w)) right = Math.max(right, l + (Number.isFinite(w) ? w : 0))
      }
      const spot = { left: right + 80, top: 0 }
      placed.push(spot)
      void size
      return spot
    },
    random: seeded(7),
    ...extra,
  }
}

export function write(
  doc: LoroDoc,
  html: string,
  targetId: string,
  mode: 'insert-children' | 'replace' = 'insert-children',
  extra: Partial<ApplyContext> = {},
): ApplyResult {
  const ctx = context(doc, extra)
  const parsed = parseHtml(html, { tokens: ctx.tokens })
  return transact(doc, () => applyHtml(doc, parsed, { mode, targetId }, ctx), {
    origin: 'agent:write_html',
  })
}

export interface TreeView {
  type: string
  name: string
  styles: Styles
  text?: string
  svg?: string
  assetId?: string
  hidden?: true
  children?: TreeView[]
}

/** A node and its subtree with canonical styles (ids left out). */
export function tree(doc: LoroDoc, id: string, opts: { geometry?: boolean } = {}): TreeView {
  const n = getNode(doc, id) as DesignNode
  const styles = canonicalStyles(n)
  if (!opts.geometry) {
    delete styles['left']
    delete styles['top']
  }
  const out: TreeView = { type: n.type, name: n.name, styles }
  if (n.text !== undefined) out.text = n.text
  if (n.svg !== undefined) out.svg = n.svg
  if (n.assetId !== undefined) out.assetId = n.assetId
  if (n.hidden) out.hidden = true
  if (n.children.length > 0) out.children = n.children.map((c) => tree(doc, c, opts))
  return out
}

export function resolved(doc: LoroDoc, id: string) {
  const sub = toRenderSubtree(doc, id)
  if (!sub) throw new Error(`no subtree for ${id}`)
  return sub.nodes
}
