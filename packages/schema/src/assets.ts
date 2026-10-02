/**
 * Asset references in documents (ARCHITECTURE.md, "Images"). Bytes live in the
 * local core (`assets.put/get`, content hash); documents only hold the hash:
 *
 *  - image layers: `type: 'image'` + `assetId: <hash>`;
 *  - image fills: `backgroundImage: 'url("baren-asset://<hash>")'` (also inside
 *    `background` and hidden paints such as `--hidden-backgroundImage`).
 *
 * Pure string/JSON helpers shared by the canvas, the editor and the sync layer. The
 * Rust core mirrors `ASSET_URL_PREFIX` and the hash format in `baren_core::export`.
 */
import type { LoroDoc } from 'loro-crdt'
import { nodesTree } from './doc.ts'
import { NODE_KEY, type DesignNode, type StyleValue } from './types.ts'

export const ASSET_SCHEME = 'baren-asset'
export const ASSET_URL_PREFIX = 'baren-asset://'

/** Image types accepted as assets (SVG files become `svg` layers instead). */
export const ACCEPTED_IMAGE_MIMES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]

/** Largest asset the app stores or syncs (the server enforces the same limit). */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024

const HASH_RE = /^[0-9a-f]{64}$/

/** A content hash as stored in documents: 64 lowercase hex digits (blake3). */
export function isAssetHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value)
}

/** `baren-asset://<hash>` */
export function assetUrlOf(hash: string): string {
  return `${ASSET_URL_PREFIX}${hash}`
}

/** CSS image value for an image fill: `url("baren-asset://<hash>")`. */
export function assetCssUrl(hash: string): string {
  return `url("${assetUrlOf(hash)}")`
}

/** `url( "baren-asset://<hash>" )` with any (or no) quotes; group 2 is the hash. */
const URL_TOKEN_RE = /url\(\s*(["']?)baren-asset:\/\/([0-9a-f]{64})\1\s*\)/g

/** Cheap pre-check before running the regexes (most style values never mention assets). */
export function mentionsAsset(value: StyleValue | undefined | null): value is string {
  return typeof value === 'string' && value.includes(ASSET_URL_PREFIX)
}

/** Asset hashes referenced by `url(baren-asset://…)` tokens in a style value, in order. */
export function assetRefsInValue(value: StyleValue | undefined | null): string[] {
  if (!mentionsAsset(value)) return []
  const out: string[] = []
  for (const m of value.matchAll(URL_TOKEN_RE)) {
    const hash = m[2] as string
    if (!out.includes(hash)) out.push(hash)
  }
  return out
}

/**
 * Replace every `url(baren-asset://<hash>)` token in `value` with `map(hash)` — a whole
 * CSS image (`url("blob:…")`, a placeholder gradient, `none`). Returns `value` unchanged
 * (same string) when it mentions no asset.
 */
export function rewriteAssetUrls(value: string, map: (hash: string) => string): string {
  if (!value.includes(ASSET_URL_PREFIX)) return value
  return value.replace(URL_TOKEN_RE, (_m, _q: string, hash: string) => map(hash))
}

/**
 * Hashes a node references: its image `assetId`, asset URLs in any style value and — on
 * instances — the `assetId`s and style URLs of its overrides.
 */
export function nodeAssetRefs(
  node: Pick<DesignNode, 'type' | 'assetId' | 'styles'> & Pick<Partial<DesignNode>, 'overrides'>,
): string[] {
  const out: string[] = []
  if (node.type === 'image' && isAssetHash(node.assetId)) out.push(node.assetId)
  for (const key in node.styles) {
    const v = node.styles[key]
    if (!mentionsAsset(v)) continue
    for (const h of assetRefsInValue(v)) if (!out.includes(h)) out.push(h)
  }
  if (node.overrides) {
    for (const entry of Object.values(node.overrides)) {
      if (isAssetHash(entry.assetId) && !out.includes(entry.assetId)) out.push(entry.assetId)
      for (const v of Object.values(entry.styles ?? {})) {
        if (!mentionsAsset(v)) continue
        for (const h of assetRefsInValue(v)) if (!out.includes(h)) out.push(h)
      }
    }
  }
  return out
}

/** Every asset hash referenced by `nodes` (a snapshot or subtree snapshot). */
export function collectAssetRefs(nodes: Record<string, DesignNode>): Set<string> {
  const out = new Set<string>()
  for (const id in nodes) {
    const node = nodes[id]
    if (node) for (const h of nodeAssetRefs(node)) out.add(h)
  }
  return out
}

function scanMeta(meta: unknown, out: Set<string>): void {
  if (typeof meta !== 'object' || meta === null) return
  const d = meta as Record<string, unknown>
  const assetId = d[NODE_KEY.assetId]
  if (d[NODE_KEY.type] === 'image' && isAssetHash(assetId)) out.add(assetId)
  scanStyles(d[NODE_KEY.styles], out)
  const overrides = d[NODE_KEY.overrides]
  if (d[NODE_KEY.type] === 'instance' && typeof overrides === 'object' && overrides !== null) {
    for (const entry of Object.values(overrides as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (isAssetHash(e['assetId'])) out.add(e['assetId'])
      scanStyles(e['styles'], out)
    }
  }
}

function scanStyles(styles: unknown, out: Set<string>): void {
  if (typeof styles !== 'object' || styles === null) return
  for (const v of Object.values(styles as Record<string, unknown>)) {
    if (typeof v === 'string' && v.includes(ASSET_URL_PREFIX))
      for (const h of assetRefsInValue(v)) out.add(h)
  }
}

/**
 * Every asset hash referenced by live nodes of `doc`. One wasm→JS call for the tree
 * (`toJSON`, no `DesignNode` decoding); deleted nodes are not part of it.
 */
export function docAssetRefs(doc: LoroDoc): Set<string> {
  const out = new Set<string>()
  const roots = nodesTree(doc).toJSON() as unknown
  const stack: unknown[] = Array.isArray(roots) ? [...roots] : []
  for (let raw = stack.pop(); raw !== undefined; raw = stack.pop()) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as { meta?: unknown; children?: unknown }
    scanMeta(r.meta, out)
    if (Array.isArray(r.children)) for (const c of r.children) stack.push(c)
  }
  return out
}
