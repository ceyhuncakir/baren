/**
 * Copy/paste within and across files and windows (contract §7): the versioned clipboard
 * payload (`web application/x-baren-clipboard+json`), its strict parser (untrusted input,
 * v1 upgraded), paste with id/token/asset/component remapping, and Ctrl+D with the same
 * deep-copy rules.
 */
import { LoroMap, type LoroDoc } from 'loro-crdt'
import { assetCssUrl, assetRefsInValue, isAssetHash, rewriteAssetUrls } from './assets.ts'
import { rebaseNestedInstance, ensureComponentsPage, nextArtboardSlot } from './components.ts'
import { decodeOverrideEntry, decodeVectorPoint, isRecord, isStyleValue } from './decode.ts'
import { tokensMap } from './doc.ts'
import {
  docGeometry,
  frameAabb,
  frameOrDeclared,
  placementStyles,
  positionContextOf,
  unionRects,
} from './geometry.ts'
import {
  componentDependencies,
  findMainComponent,
  mainKeysAbove,
  rawSubtree,
  writeRegistry,
} from './graph.ts'
import { ensureContainingBlock, fitGroups } from './groups.ts'
import {
  isComponentKey,
  isNodeKey,
  isOverridePath,
  isSubpathId,
  isTreeId,
  newComponentKey,
  parseVirtualId,
} from './ids.ts'
import { createNode, decodeNode, getNode, getParentId, type CreateNodeInput } from './nodes.ts'
import { topmostRefs } from './refs.ts'
import { createComponentResolver, type ComponentResolver, type ResolvedNode } from './resolve.ts'
import { readRotation } from './rotation.ts'
import { toSubtreeSnapshot } from './snapshot.ts'
import { getTokens, isTokenName } from './tokens.ts'
import {
  CONTAINER_NODE_TYPES,
  NODE_TYPES,
  isInstanceOwnKey,
  type DesignNode,
  type GeometrySource,
  type NodeFrame,
  type NodeType,
  type OverrideEntry,
  type Rect,
  type StylePatch,
  type Styles,
  type Token,
  type VectorData,
  type VectorSubpath,
} from './types.ts'
import { round2, run, toPx } from './util.ts'
import { vectorToSvgMarkup } from './vector.ts'

export const CLIPBOARD_MIME = 'web application/x-baren-clipboard+json'
export const CLIPBOARD_KIND = 'baren/clipboard'
export const CLIPBOARD_VERSION = 2
/** Embedded raw asset bytes, total. */
export const MAX_CLIPBOARD_ASSET_BYTES = 24 * 1024 * 1024
export const MAX_CLIPBOARD_NODES = 50_000

export interface ClipNode {
  type: NodeType
  name: string
  styles: Styles
  text?: string
  svg?: string
  assetId?: string
  assetName?: string
  locked?: true
  hidden?: true
  componentKey?: string
  nodeKey?: string
  /** Dropped (re-pointed) on paste. */
  mainId?: string
  overrides?: Record<string, OverrideEntry>
  vector?: VectorData
  children: ClipNode[]
  /** Roots only: world frame at copy time. */
  frame?: NodeFrame
  /** Roots only: the source parent's positioning context. */
  context?: 'page' | 'flow' | 'absolute'
}

export interface ClipComponent {
  key: string
  name: string
  /** The main subtree. */
  root: ClipNode
}

export interface ClipAsset {
  mime?: string
  name?: string
  size?: number
  /** Base64 bytes (absent when over the embedding budget). */
  data?: string
}

export interface ClipboardPayload {
  kind: 'baren/clipboard'
  version: 2
  source: { fileId: string | null; pageId: string; app: string }
  /** World AABB of all roots at copy time. */
  bounds: Rect | null
  /** Copied roots, paint order (back to front). */
  nodes: ClipNode[]
  /** Mains needed by instances in `nodes` (transitively), minus mains inside `nodes`. */
  components: Record<string, ClipComponent>
  tokens: Record<string, Token>
  assets: Record<string, ClipAsset>
}

// ---------------------------------------------------------------------------
// Building clip nodes
// ---------------------------------------------------------------------------

function clipFromNode(n: DesignNode | ResolvedNode): ClipNode {
  const out: ClipNode = {
    type: n.type === 'page' ? 'frame' : n.type,
    name: n.name,
    styles: { ...n.styles },
    children: [],
  }
  if (n.type === 'text') out.text = n.text ?? ''
  if (n.svg !== undefined) out.svg = n.svg
  if (n.assetId !== undefined) out.assetId = n.assetId
  if (n.assetName !== undefined) out.assetName = n.assetName
  if (n.locked === true) out.locked = true
  if (n.hidden === true) out.hidden = true
  if (n.componentKey !== undefined && (n.type === 'frame' || n.type === 'instance'))
    out.componentKey = n.componentKey
  if (n.nodeKey !== undefined) out.nodeKey = n.nodeKey
  if (n.type === 'instance') {
    if (n.mainId !== undefined) out.mainId = n.mainId
    out.overrides = structuredClone(n.overrides ?? {})
  }
  if (n.vector !== undefined) out.vector = structuredClone(n.vector)
  return out
}

/** A real subtree as clip nodes (instances stay instances). */
function clipFromSnapshot(
  nodes: Record<string, DesignNode>,
  id: string,
  depth = 0,
): ClipNode | null {
  const n = nodes[id]
  if (!n) return null
  const out = clipFromNode(n)
  if (depth < 256 && n.type !== 'instance') {
    for (const c of n.children) {
      const child = clipFromSnapshot(nodes, c, depth + 1)
      if (child) out.children.push(child)
    }
  }
  return out
}

/** Raw (possibly retained) subtree JSON as clip nodes. */
function clipFromRaw(raw: unknown, depth = 0): ClipNode | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') return null
  const d = decodeNode(raw['id'], null, [], raw['meta'])
  const out = clipFromNode(d)
  if (depth < 256 && d.type !== 'instance' && Array.isArray(raw['children'])) {
    for (const c of raw['children']) {
      const child = clipFromRaw(c, depth + 1)
      if (child) out.children.push(child)
    }
  }
  return out
}

/**
 * Expanded content of an instance as a detached copy: effective styles/text; nested instances
 * stay instances with their overrides rebased (§7.2 "virtual roots"). `nodes` is the outer
 * instance's full expansion.
 */
function clipFromResolved(
  doc: LoroDoc,
  nodes: Record<string, ResolvedNode>,
  ref: string,
  outer: Record<string, OverrideEntry> | undefined,
  depth = 0,
): ClipNode | null {
  const n = nodes[ref]
  if (!n) return null
  if (n.type === 'instance') {
    const input = rebaseNestedInstance(doc, n, outer, nodes)
    return input ? clipFromInput(input) : null
  }
  const out = clipFromNode(n)
  delete out.componentKey
  if (depth < 256) {
    for (const c of n.children) {
      const child = clipFromResolved(doc, nodes, c, outer, depth + 1)
      if (child) out.children.push(child)
    }
  }
  return out
}

/** A virtual ref as a detached clip (null when it does not resolve). */
function clipFromVirtual(
  doc: LoroDoc,
  ref: string,
  instanceId: string,
  resolver: ComponentResolver,
): ClipNode | null {
  const exp = resolver.expandInstance(instanceId)
  if (!exp) return null
  return clipFromResolved(doc, exp.nodes, ref, getNode(doc, instanceId)?.overrides)
}

function clipFromInput(input: Omit<CreateNodeInput, 'parentId'>): ClipNode {
  const out: ClipNode = {
    type: input.type,
    name: input.name ?? '',
    styles: { ...(input.styles ?? {}) },
    children: [],
  }
  if (input.hidden === true) out.hidden = true
  if (input.locked === true) out.locked = true
  if (input.componentKey !== undefined) out.componentKey = input.componentKey
  if (input.nodeKey !== undefined) out.nodeKey = input.nodeKey
  if (input.mainId !== undefined) out.mainId = input.mainId
  if (input.overrides !== undefined) out.overrides = input.overrides
  return out
}

function walkClips(nodes: readonly ClipNode[], fn: (n: ClipNode) => void): void {
  const stack = [...nodes]
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    fn(n)
    for (const c of n.children) stack.push(c)
  }
}

/** Instance keys used anywhere in `nodes`. */
function clipInstanceKeys(nodes: readonly ClipNode[]): Set<string> {
  const out = new Set<string>()
  walkClips(nodes, (n) => {
    if (n.type === 'instance' && n.componentKey !== undefined) out.add(n.componentKey)
  })
  return out
}

/** Keys of mains (frames with a key) inside `nodes`. */
function clipMainKeys(nodes: readonly ClipNode[]): Map<string, ClipNode> {
  const out = new Map<string, ClipNode>()
  walkClips(nodes, (n) => {
    if (n.type === 'frame' && n.componentKey !== undefined && !out.has(n.componentKey))
      out.set(n.componentKey, n)
  })
  return out
}

const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g

/** Token names referenced (`var(--x)`) by styles and override styles, transitively. */
export function tokensReferencedBy(
  nodes: Iterable<Pick<DesignNode, 'styles' | 'overrides'>>,
  tokens: Record<string, Token>,
): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const scan = (v: unknown): void => {
    if (typeof v !== 'string' || !v.includes('var(')) return
    for (const m of v.matchAll(VAR_RE)) {
      const name = m[1] as string
      if (seen.has(name) || !tokens[name]) continue
      seen.add(name)
      found.push(name)
    }
  }
  for (const n of nodes) {
    for (const v of Object.values(n.styles)) scan(v)
    for (const e of Object.values(n.overrides ?? {}))
      for (const v of Object.values(e.styles ?? {})) scan(v)
  }
  for (let i = 0; i < found.length; i++) scan(tokens[found[i] as string]?.value)
  return found
}

function clipAssetRefs(n: ClipNode, add: (hash: string, name?: string) => void): void {
  if (n.type === 'image' && n.assetId !== undefined && isAssetHash(n.assetId))
    add(n.assetId, n.assetName)
  for (const v of Object.values(n.styles)) for (const h of assetRefsInValue(v)) add(h)
  for (const e of Object.values(n.overrides ?? {})) {
    if (e.assetId !== undefined && isAssetHash(e.assetId)) add(e.assetId, e.assetName)
    for (const v of Object.values(e.styles ?? {}))
      if (v !== null) for (const h of assetRefsInValue(v)) add(h)
  }
}

function contextOf(
  doc: LoroDoc,
  node: ResolvedNode | DesignNode,
  resolver: ComponentResolver,
): 'page' | 'flow' | 'absolute' {
  const parent = node.parentId === null ? undefined : resolver.resolveNode(node.parentId)
  if (!parent || parent.type === 'page') return 'page'
  if (parent.type === 'group') return 'absolute'
  const p = node.styles['position']
  return p === 'absolute' || p === 'fixed' ? 'absolute' : 'flow'
}

/**
 * Serialise refs (real or virtual) into a payload v2 (without asset bytes — see
 * `attachAssetBytes`). Null when nothing copyable is selected.
 */
export function serializeClipboard(
  doc: LoroDoc,
  refs: readonly string[],
  ctx: {
    geo: GeometrySource
    fileId: string | null
    pageId: string
    app?: string
    resolver?: ComponentResolver
  },
): ClipboardPayload | null {
  const resolver = ctx.resolver ?? createComponentResolver(doc)
  const roots = topmostRefs(doc, refs, resolver)
  if (roots.length === 0) return null
  const declared = docGeometry(doc, resolver)
  const nodes: ClipNode[] = []
  const frames: Rect[] = []
  for (const ref of roots) {
    let clip: ClipNode | null
    const virtual = parseVirtualId(ref)
    if (virtual) {
      clip = clipFromVirtual(doc, ref, virtual.instanceId, resolver)
    } else {
      const sub = toSubtreeSnapshot(doc, ref)
      clip = sub ? clipFromSnapshot(sub.nodes, ref) : null
    }
    const node = resolver.resolveNode(ref)
    if (!clip || !node) continue
    const frame = frameOrDeclared(doc, ctx.geo, ref, declared)
    if (frame) {
      clip.frame = { ...frame }
      frames.push(frameAabb(frame))
    }
    clip.context = contextOf(doc, node, resolver)
    nodes.push(clip)
  }
  if (nodes.length === 0) return null

  // Components: the mains instances need, transitively, minus mains already inside `nodes`.
  const components: Record<string, ClipComponent> = {}
  const inNodes = clipMainKeys(nodes)
  const hints = new Map<string, string>()
  walkClips(nodes, (n) => {
    if (n.type === 'instance' && n.componentKey && n.mainId) hints.set(n.componentKey, n.mainId)
  })
  const queue = [...clipInstanceKeys(nodes)]
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    if (inNodes.has(key) || components[key]) continue
    const found = findMainComponent(doc, key, hints.get(key))
    if (!found) continue
    const root = clipFromRaw(rawSubtree(doc, found.mainId))
    if (!root) continue
    components[key] = { key, name: root.name, root }
    walkClips([root], (n) => {
      if (n.type === 'instance' && n.componentKey && n.mainId) hints.set(n.componentKey, n.mainId)
    })
    for (const k of clipInstanceKeys([root])) queue.push(k)
  }

  const docTokens = getTokens(doc)
  const all: ClipNode[] = []
  walkClips([...nodes, ...Object.values(components).map((c) => c.root)], (n) => all.push(n))
  const tokens: Record<string, Token> = {}
  for (const name of tokensReferencedBy(all, docTokens))
    tokens[name] = { ...(docTokens[name] as Token) }
  const assets: Record<string, ClipAsset> = {}
  for (const n of all) {
    clipAssetRefs(n, (hash, name) => {
      const entry = (assets[hash] ??= {})
      if (name !== undefined && entry.name === undefined) entry.name = name
    })
  }
  return {
    kind: CLIPBOARD_KIND,
    version: CLIPBOARD_VERSION,
    source: { fileId: ctx.fileId, pageId: ctx.pageId, app: ctx.app ?? '' },
    bounds: unionRects(frames),
    nodes,
    components,
    tokens,
    assets,
  }
}

// ---------------------------------------------------------------------------
// Asset bytes
// ---------------------------------------------------------------------------

/** Base64 of raw bytes (chunked; works in browsers, workers and Node). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Bytes of base64 text, or null when it is not valid base64. */
export function base64ToBytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** The embedded bytes of a clipboard asset, if any. */
export function clipAssetBytes(asset: ClipAsset): Uint8Array | null {
  return asset.data === undefined ? null : base64ToBytes(asset.data)
}

/**
 * Embed asset bytes (smallest first) until `limit` raw bytes; the others keep only their
 * metadata. Returns a new payload.
 */
export async function attachAssetBytes(
  payload: ClipboardPayload,
  read: (hash: string) => Promise<{ bytes: Uint8Array; mime: string } | null>,
  limit: number = MAX_CLIPBOARD_ASSET_BYTES,
): Promise<ClipboardPayload> {
  const hashes = Object.keys(payload.assets)
  const loaded = await Promise.all(
    hashes.map(async (hash) => ({ hash, file: await read(hash).catch(() => null) })),
  )
  loaded.sort((a, b) => (a.file?.bytes.length ?? 0) - (b.file?.bytes.length ?? 0))
  const assets: Record<string, ClipAsset> = {}
  let total = 0
  for (const { hash, file } of loaded) {
    const entry: ClipAsset = { ...payload.assets[hash] }
    if (file) {
      entry.mime = file.mime
      entry.size = file.bytes.length
      if (total + file.bytes.length <= limit) {
        entry.data = bytesToBase64(file.bytes)
        total += file.bytes.length
      }
    }
    assets[hash] = entry
  }
  return { ...payload, assets }
}

// ---------------------------------------------------------------------------
// Parsing (untrusted input)
// ---------------------------------------------------------------------------

const MAX_STRING = 1024 * 1024
const MAX_SVG = 4 * 1024 * 1024
const MAX_DATA = 28 * 1024 * 1024
const MAX_PARSE_DEPTH = 256

class Invalid extends Error {}

function str(v: unknown, max = MAX_STRING): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function parseStyles(v: unknown): Styles {
  const out: Styles = {}
  if (!isRecord(v)) return out
  for (const [k, value] of Object.entries(v)) {
    if (k.length > 256) continue
    if (isStyleValue(value) && (typeof value !== 'string' || value.length <= MAX_STRING))
      out[k] = value
  }
  return out
}

function parseFrame(v: unknown): NodeFrame | undefined {
  if (!isRecord(v)) return undefined
  const { x, y, width, height } = v
  const rotation = v['rotation'] ?? 0
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || !finite(rotation))
    return undefined
  return { x, y, width, height, rotation }
}

function parseRect(v: unknown): Rect | null {
  if (!isRecord(v)) return null
  const { x, y, width, height } = v
  return finite(x) && finite(y) && finite(width) && finite(height) ? { x, y, width, height } : null
}

function parseOverrides(v: unknown): Record<string, OverrideEntry> {
  const out: Record<string, OverrideEntry> = {}
  if (!isRecord(v)) return out
  for (const [path, raw] of Object.entries(v)) {
    if (!isOverridePath(path)) continue
    const entry = decodeOverrideEntry(raw)
    if (!entry) continue
    if (entry.assetId !== undefined && !isAssetHash(entry.assetId)) delete entry.assetId
    if (entry.text !== undefined && entry.text.length > MAX_STRING) delete entry.text
    if (entry.assetName !== undefined && entry.assetName.length > MAX_STRING) delete entry.assetName
    if (entry.styles) {
      for (const [k, s] of Object.entries(entry.styles)) {
        if (typeof s === 'string' && s.length > MAX_STRING) delete entry.styles[k]
      }
    }
    out[path] = entry
  }
  return out
}

function parseVector(v: unknown): VectorData {
  const out: VectorData = { fillRule: 'nonzero', subpaths: [] }
  if (!isRecord(v)) return out
  if (v['fillRule'] === 'evenodd') out.fillRule = 'evenodd'
  if (!Array.isArray(v['subpaths'])) return out
  const ids = new Set<string>()
  for (const raw of v['subpaths']) {
    if (!isRecord(raw) || !isSubpathId(raw['id']) || ids.has(raw['id'])) continue
    if (!Array.isArray(raw['points'])) continue
    const points = raw['points'].map(decodeVectorPoint).filter((p) => p !== undefined)
    if (points.length === 0) continue
    ids.add(raw['id'])
    const sp: VectorSubpath = { id: raw['id'], closed: raw['closed'] === true, points }
    out.subpaths.push(sp)
  }
  return out
}

function parseNode(
  v: unknown,
  depth: number,
  count: { n: number },
  root: boolean,
): ClipNode | null {
  if (depth > MAX_PARSE_DEPTH) throw new Invalid('too deep')
  if (!isRecord(v)) return null
  if (++count.n > MAX_CLIPBOARD_NODES) throw new Invalid('too many nodes')
  const rawType = v['type']
  let type: NodeType =
    typeof rawType === 'string' &&
    (NODE_TYPES as readonly string[]).includes(rawType) &&
    rawType !== 'page'
      ? (rawType as NodeType)
      : 'frame'
  const componentKey = isComponentKey(v['componentKey']) ? v['componentKey'] : undefined
  if (type === 'instance' && componentKey === undefined) type = 'frame'
  const out: ClipNode = {
    type,
    name: str(v['name']) ?? '',
    styles: parseStyles(v['styles']),
    children: [],
  }
  if (type === 'text') out.text = str(v['text']) ?? ''
  const svg = str(v['svg'], MAX_SVG)
  if (svg !== undefined) out.svg = svg
  if (isAssetHash(v['assetId'])) out.assetId = v['assetId']
  const assetName = str(v['assetName'])
  if (assetName !== undefined) out.assetName = assetName
  if (v['locked'] === true) out.locked = true
  if (v['hidden'] === true) out.hidden = true
  if (componentKey !== undefined && (type === 'frame' || type === 'instance'))
    out.componentKey = componentKey
  if (isNodeKey(v['nodeKey'])) out.nodeKey = v['nodeKey']
  if (type === 'instance') {
    if (isTreeId(v['mainId'])) out.mainId = v['mainId']
    out.overrides = parseOverrides(v['overrides'])
  }
  if (type === 'vector') out.vector = parseVector(v['vector'])
  if (CONTAINER_NODE_TYPES.has(type) && Array.isArray(v['children'])) {
    for (const c of v['children']) {
      const child = parseNode(c, depth + 1, count, false)
      if (child) out.children.push(child)
    }
  }
  if (root) {
    const frame = parseFrame(v['frame'])
    if (frame) out.frame = frame
    const context = v['context']
    if (context === 'page' || context === 'flow' || context === 'absolute') out.context = context
  }
  return out
}

/** Frame and context of a root that has none (v1 payloads): from its declared styles. */
function deriveRoot(n: ClipNode): void {
  const s = n.styles
  const position = s['position']
  if (!n.context) {
    n.context =
      position === 'absolute' || position === 'fixed'
        ? 'absolute'
        : s['left'] !== undefined || s['top'] !== undefined
          ? 'page'
          : 'flow'
  }
  n.frame ??= {
    x: toPx(s['left']) ?? 0,
    y: toPx(s['top']) ?? 0,
    width: toPx(s['width']) ?? 0,
    height: toPx(s['height']) ?? 0,
    rotation: readRotation(s),
  }
}

/** `version` of a clipboard JSON of either kind (to tell "from a newer version" apart). */
export function clipboardPayloadVersion(json: string): number | null {
  try {
    const v = JSON.parse(json) as unknown
    if (!isRecord(v)) return null
    if (v['kind'] !== CLIPBOARD_KIND && v['kind'] !== 'baren/nodes') return null
    return typeof v['version'] === 'number' ? v['version'] : null
  } catch {
    return null
  }
}

/**
 * Strict parse of clipboard JSON (untrusted): exact kind/version, every field type-checked,
 * limits enforced; invalid entries are dropped and a structurally invalid payload is null.
 * The legacy v1 format (`{ kind: 'baren/nodes', version: 1 }`) is upgraded.
 */
export function parseClipboardPayload(json: string): ClipboardPayload | null {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(v)) return null
  const count = { n: 0 }
  try {
    if (v['kind'] === 'baren/nodes' && v['version'] === 1) {
      if (!Array.isArray(v['nodes'])) return null
      const nodes = v['nodes'].map((n) => parseNode(n, 0, count, true)).filter((n) => n !== null)
      for (const n of nodes) deriveRoot(n)
      const assets: Record<string, ClipAsset> = {}
      for (const n of nodes) walkClips([n], (c) => clipAssetRefs(c, (h) => (assets[h] ??= {})))
      return {
        kind: CLIPBOARD_KIND,
        version: CLIPBOARD_VERSION,
        source: { fileId: null, pageId: '', app: '' },
        bounds: unionRects(nodes.map((n) => frameAabb(n.frame as NodeFrame))),
        nodes,
        components: {},
        tokens: {},
        assets,
      }
    }
    if (v['kind'] !== CLIPBOARD_KIND || v['version'] !== CLIPBOARD_VERSION) return null
    const source = v['source']
    if (!isRecord(source)) return null
    const fileId = source['fileId'] === null ? null : str(source['fileId'])
    const pageId = str(source['pageId'])
    const app = str(source['app'])
    if (fileId === undefined || pageId === undefined || app === undefined) return null
    if (!Array.isArray(v['nodes'])) return null
    const bounds = v['bounds'] === null || v['bounds'] === undefined ? null : parseRect(v['bounds'])
    if (v['bounds'] !== null && v['bounds'] !== undefined && bounds === null) return null
    const nodes = v['nodes'].map((n) => parseNode(n, 0, count, true)).filter((n) => n !== null)
    for (const n of nodes) deriveRoot(n)
    const components: Record<string, ClipComponent> = {}
    if (v['components'] !== undefined && !isRecord(v['components'])) return null
    for (const [key, raw] of Object.entries((v['components'] as Record<string, unknown>) ?? {})) {
      if (!isComponentKey(key) || !isRecord(raw) || raw['key'] !== key) continue
      const root = parseNode(raw['root'], 0, count, false)
      if (!root || root.type !== 'frame') continue
      root.componentKey = key
      components[key] = { key, name: str(raw['name']) ?? root.name, root }
    }
    const tokens: Record<string, Token> = {}
    if (v['tokens'] !== undefined && !isRecord(v['tokens'])) return null
    for (const [name, raw] of Object.entries((v['tokens'] as Record<string, unknown>) ?? {})) {
      if (!isTokenName(name) || !isRecord(raw)) continue
      const value = raw['value']
      if (!(typeof value === 'string' ? value.length <= MAX_STRING : finite(value))) continue
      const token: Token = {
        type: str(raw['type'], 256) ?? 'other',
        value: value as string | number,
      }
      const description = str(raw['description'])
      if (description !== undefined) token.description = description
      tokens[name] = token
    }
    const assets: Record<string, ClipAsset> = {}
    if (v['assets'] !== undefined && !isRecord(v['assets'])) return null
    for (const [hash, raw] of Object.entries((v['assets'] as Record<string, unknown>) ?? {})) {
      if (!isAssetHash(hash) || !isRecord(raw)) continue
      const asset: ClipAsset = {}
      const mime = str(raw['mime'], 256)
      if (mime !== undefined) asset.mime = mime
      const name = str(raw['name'])
      if (name !== undefined) asset.name = name
      if (finite(raw['size']) && raw['size'] >= 0) asset.size = raw['size']
      const data = str(raw['data'], MAX_DATA)
      if (data !== undefined && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) asset.data = data
      assets[hash] = asset
    }
    return {
      kind: CLIPBOARD_KIND,
      version: CLIPBOARD_VERSION,
      source: { fileId, pageId, app },
      bounds,
      nodes,
      components,
      tokens,
      assets,
    }
  } catch (err) {
    if (err instanceof Invalid) return null
    throw err
  }
}

// ---------------------------------------------------------------------------
// text/plain
// ---------------------------------------------------------------------------

/** text/plain (§7.3): text layers' text; else a single vector/svg's markup; else the names. */
export function clipboardText(payload: ClipboardPayload): string {
  const texts: string[] = []
  const mains = clipMainKeys(payload.nodes)
  const visit = (
    n: ClipNode,
    overrides: Record<string, OverrideEntry> | undefined,
    depth: number,
  ): void => {
    if (n.hidden || depth > 32) return
    if (n.type === 'text') {
      const o = n.nodeKey !== undefined ? overrides?.[n.nodeKey]?.text : undefined
      texts.push(o ?? n.text ?? '')
    }
    if (n.type === 'instance' && n.componentKey) {
      const main = payload.components[n.componentKey]?.root ?? mains.get(n.componentKey)
      if (main) for (const c of main.children) visit(c, n.overrides, depth + 1)
      return
    }
    for (const c of n.children) visit(c, overrides, depth + 1)
  }
  for (const n of payload.nodes) visit(n, undefined, 0)
  if (texts.length > 0) return texts.join('\n')
  const only = payload.nodes.length === 1 ? payload.nodes[0] : undefined
  if (only?.type === 'vector') return vectorToSvgMarkup(only, payload.tokens)
  if (only?.type === 'svg' && only.svg !== undefined) return only.svg
  // An unnamed instance shows its main's name (layers panel, canvas), so it copies as that too.
  const nameOf = (n: ClipNode): string => {
    if (n.name !== '' || n.type !== 'instance' || !n.componentKey) return n.name
    return (payload.components[n.componentKey]?.root ?? mains.get(n.componentKey))?.name ?? ''
  }
  return payload.nodes.map(nameOf).join('\n')
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

export interface PasteOptions {
  /** Page, frame or group. */
  parentId: string
  /** Index of the first root among the new siblings. */
  index?: number
  /** World offset applied to root frames (default 0, 0). */
  translate?: { dx: number; dy: number }
  geo: GeometrySource
  /** Payload hash → stored hash (when they differ). */
  assetRemap?: Record<string, string>
  origin?: string
  random?: () => number
}

export interface PasteResult {
  ids: string[]
  /** Component keys whose mains were created / already present (reused). */
  components: { created: string[]; reused: string[] }
  tokens: { added: string[]; kept: string[] }
  refused: 'cycle' | 'invalid-target' | null
}

interface CreateCtx {
  keepKeys: boolean
  remap: Record<string, string>
  random?: () => number
}

function remapStyles(styles: Styles, remap: Record<string, string>): Styles {
  const out: Styles = {}
  for (const [k, v] of Object.entries(styles)) {
    out[k] = typeof v === 'string' ? rewriteAssetUrls(v, (h) => assetCssUrl(remap[h] ?? h)) : v
  }
  return out
}

function remapOverrides(
  overrides: Record<string, OverrideEntry>,
  remap: Record<string, string>,
): Record<string, OverrideEntry> {
  const out: Record<string, OverrideEntry> = {}
  for (const [path, e] of Object.entries(overrides)) {
    const entry: OverrideEntry = { ...e }
    if (e.styles) {
      const styles: Record<string, string | number | null> = {}
      for (const [k, v] of Object.entries(e.styles)) {
        styles[k] =
          typeof v === 'string' ? rewriteAssetUrls(v, (h) => assetCssUrl(remap[h] ?? h)) : v
      }
      entry.styles = styles
    }
    if (e.assetId !== undefined) entry.assetId = remap[e.assetId] ?? e.assetId
    out[path] = entry
  }
  return out
}

/** Create a clip subtree; mains get a fresh key when theirs is live, registry written. */
function createClip(
  doc: LoroDoc,
  clip: ClipNode,
  parentId: string,
  index: number | undefined,
  ctx: CreateCtx,
): string {
  const type: NodeType = clip.type === 'page' ? 'frame' : clip.type
  const input: CreateNodeInput = {
    type,
    parentId,
    name: clip.name,
    styles: remapStyles(clip.styles, ctx.remap),
  }
  if (index !== undefined) input.index = index
  if (type === 'text') input.text = clip.text ?? ''
  if (clip.svg !== undefined) input.svg = clip.svg
  if (clip.assetId !== undefined) input.assetId = ctx.remap[clip.assetId] ?? clip.assetId
  if (clip.assetName !== undefined) input.assetName = clip.assetName
  if (clip.locked) input.locked = true
  if (clip.hidden) input.hidden = true
  if (ctx.keepKeys && clip.nodeKey !== undefined) input.nodeKey = clip.nodeKey
  let mainKey: string | undefined
  if (type === 'frame' && clip.componentKey !== undefined) {
    const live = findMainComponent(doc, clip.componentKey)
    mainKey = live && !live.deleted ? newComponentKey(ctx.random) : clip.componentKey
    input.componentKey = mainKey
  }
  if (type === 'instance' && clip.componentKey !== undefined) {
    input.componentKey = clip.componentKey
    const found = findMainComponent(doc, clip.componentKey)
    if (found) input.mainId = found.mainId
    input.overrides = remapOverrides(clip.overrides ?? {}, ctx.remap)
  }
  if (type === 'vector') input.vector = clip.vector ?? { fillRule: 'nonzero', subpaths: [] }
  const id = createNode(doc, input, ctx.random ? { random: ctx.random } : {})
  if (mainKey !== undefined) writeRegistry(doc, mainKey, id)
  if (CONTAINER_NODE_TYPES.has(type)) {
    for (const c of clip.children) createClip(doc, c, id, undefined, ctx)
  }
  return id
}

/**
 * True when pasting would make a main contain itself: the instance keys of `nodes`, followed
 * through the mains the target will use (its live mains, else the payload's), reach a main
 * around the target — or a main the paste creates reaches itself.
 */
function pasteCreatesCycle(doc: LoroDoc, payload: ClipboardPayload, parentId: string): boolean {
  const payloadMains = new Map<string, ClipNode>()
  for (const [k, c] of Object.entries(payload.components)) payloadMains.set(k, c.root)
  for (const [k, n] of clipMainKeys(payload.nodes)) if (!payloadMains.has(k)) payloadMains.set(k, n)
  const depsOf = (key: string): Set<string> => {
    const live = findMainComponent(doc, key)
    if (live && !live.deleted) return componentDependencies(doc, key)
    const clip = payloadMains.get(key)
    if (!clip) return componentDependencies(doc, key)
    const out = new Set<string>()
    const queue = [...clipInstanceKeys([clip])]
    for (let k = queue.pop(); k !== undefined; k = queue.pop()) {
      if (out.has(k)) continue
      out.add(k)
      const l = findMainComponent(doc, k)
      if (l && !l.deleted) for (const d of componentDependencies(doc, k)) out.add(d)
      else {
        const c = payloadMains.get(k)
        if (c) for (const d of clipInstanceKeys([c])) queue.push(d)
        else for (const d of componentDependencies(doc, k)) out.add(d)
      }
    }
    return out
  }
  const above = mainKeysAbove(doc, parentId)
  if (above.length > 0) {
    const closure = new Set<string>()
    for (const k of clipInstanceKeys(payload.nodes)) {
      closure.add(k)
      for (const d of depsOf(k)) closure.add(d)
    }
    if (above.some((k) => closure.has(k))) return true
  }
  for (const key of payloadMains.keys()) {
    const live = findMainComponent(doc, key)
    if (live && !live.deleted) continue
    if (depsOf(key).has(key)) return true
  }
  return false
}

function addTokens(
  doc: LoroDoc,
  tokens: Record<string, Token>,
): { added: string[]; kept: string[] } {
  const existing = getTokens(doc)
  const map = tokensMap(doc)
  let order = 0
  for (const name of map.keys()) {
    const e = map.get(name)
    const o = e instanceof LoroMap ? e.get('order') : undefined
    if (typeof o === 'number' && o + 1 > order) order = o + 1
  }
  const added: string[] = []
  const kept: string[] = []
  for (const [name, token] of Object.entries(tokens)) {
    if (!isTokenName(name)) continue
    if (existing[name]) {
      kept.push(name)
      continue
    }
    const entry = map.ensureMergeableMap(name)
    entry.set('type', token.type)
    entry.set('value', token.value)
    if (token.description !== undefined) entry.set('description', token.description)
    entry.set('order', order++)
    added.push(name)
  }
  return { added, kept }
}

/** Root styles for the target context: the clip's styles with placement for `world`. */
function placedStyles(
  doc: LoroDoc,
  clip: ClipNode,
  parentId: string,
  world: NodeFrame,
  parentFrame: NodeFrame | null,
): Styles {
  const styles: Styles = { ...clip.styles }
  const patch: StylePatch = placementStyles(doc, parentId, world, parentFrame)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete styles[k]
    else styles[k] = v
  }
  const context = positionContextOf(getNode(doc, parentId))
  if (
    context !== 'flow' &&
    (context === 'group' || clip.context === 'flow') &&
    clip.type !== 'instance'
  ) {
    for (const [key, size] of [
      ['width', world.width],
      ['height', world.height],
    ] as const) {
      const v = styles[key]
      if (toPx(v) !== null) continue
      if (v === undefined && clip.type === 'text') continue
      styles[key] = round2(size)
    }
  }
  return styles
}

/**
 * Paste a payload under `parentId` as one commit: missing tokens added, missing mains created
 * on the "Components" page (same key and node keys; reused when live), nodes created with new
 * ids, roots placed at `frame + translate` in the target's context. A paste that would create
 * a component cycle is refused as a whole.
 */
export function pasteClipboard(
  doc: LoroDoc,
  payload: ClipboardPayload,
  opts: PasteOptions,
): PasteResult {
  const empty = (refused: PasteResult['refused']): PasteResult => ({
    ids: [],
    components: { created: [], reused: [] },
    tokens: { added: [], kept: [] },
    refused,
  })
  const parent = isTreeId(opts.parentId) ? getNode(doc, opts.parentId) : undefined
  if (!parent || !CONTAINER_NODE_TYPES.has(parent.type)) return empty('invalid-target')
  if (pasteCreatesCycle(doc, payload, opts.parentId)) return empty('cycle')
  const remap = opts.assetRemap ?? {}
  return run(doc, opts.origin ?? 'editor:clipboard', () => {
    const tokens = addTokens(doc, payload.tokens)
    const created: string[] = []
    const reused: string[] = []
    const inNodes = clipMainKeys(payload.nodes)
    for (const [key, comp] of Object.entries(payload.components)) {
      const live = findMainComponent(doc, key)
      if (live && !live.deleted) {
        reused.push(key)
        continue
      }
      if (inNodes.has(key)) continue
      const pageId = ensureComponentsPage(doc)
      const slot = nextArtboardSlot(doc, pageId)
      const styles: Styles = { ...comp.root.styles }
      for (const k of ['position', 'right', 'bottom', 'inset']) delete styles[k]
      styles['left'] = slot.left
      styles['top'] = slot.top
      if (toPx(styles['width']) === null) styles['width'] = 100
      if (toPx(styles['height']) === null) styles['height'] = 100
      const root: ClipNode = { ...comp.root, componentKey: key, styles }
      delete root.nodeKey
      const id = createClip(doc, root, pageId, undefined, {
        keepKeys: true,
        remap,
        ...(opts.random ? { random: opts.random } : {}),
      })
      // Same lineage: the key is kept (createClip only re-keys live keys).
      writeRegistry(doc, key, id)
      created.push(key)
    }
    const insideMain = mainKeysAbove(doc, opts.parentId).length > 0
    const target = getNode(doc, opts.parentId)
    const context = positionContextOf(target)
    const parentFrame =
      context === 'page' ? null : frameOrDeclared(doc, opts.geo, opts.parentId, docGeometry(doc))
    const dx = opts.translate?.dx ?? 0
    const dy = opts.translate?.dy ?? 0
    const ids: string[] = []
    payload.nodes.forEach((clip, i) => {
      const f = clip.frame ?? { x: 0, y: 0, width: 0, height: 0, rotation: 0 }
      const world: NodeFrame = { ...f, x: f.x + dx, y: f.y + dy }
      const placed: ClipNode = {
        ...clip,
        styles: placedStyles(doc, clip, opts.parentId, world, parentFrame),
      }
      const index = opts.index === undefined ? undefined : opts.index + i
      ids.push(
        createClip(doc, placed, opts.parentId, index, {
          keepKeys: !insideMain,
          remap,
          ...(opts.random ? { random: opts.random } : {}),
        }),
      )
    })
    if (context === 'absolute') ensureContainingBlock(doc, opts.parentId)
    fitGroups(doc, ids, opts.geo)
    return { ids, components: { created, reused }, tokens, refused: null }
  })
}

/**
 * Ctrl+D: the same deep-copy rules as paste, without the clipboard. Copies of real nodes go
 * right after each original with identical styles (then `placeRoot`'s patch); copies of
 * virtual nodes are detached copies placed after their instance at the same world position.
 */
export function duplicateNodes(
  doc: LoroDoc,
  refs: readonly string[],
  geo: GeometrySource,
  opts: { placeRoot?: (node: DesignNode) => StylePatch | null; origin?: string } = {},
): string[] {
  return run(doc, opts.origin ?? 'canvas:duplicate', () => {
    const resolver = createComponentResolver(doc)
    const top = topmostRefs(doc, refs, resolver)
    const declared = docGeometry(doc, resolver)
    const out: string[] = []
    for (const ref of top) {
      const virtual = parseVirtualId(ref)
      const realId = virtual?.instanceId ?? ref
      const parentId = getParentId(doc, realId)
      if (parentId === null) continue
      const index = (getNode(doc, parentId)?.children.indexOf(realId) ?? -1) + 1
      const keepKeys = mainKeysAbove(doc, parentId).length === 0
      let clip: ClipNode | null
      let node: DesignNode | ResolvedNode | undefined
      if (virtual) {
        clip = clipFromVirtual(doc, ref, virtual.instanceId, resolver)
        node = resolver.resolveNode(ref)
        const frame = frameOrDeclared(doc, geo, ref, declared)
        if (clip && frame) {
          const parentFrame =
            positionContextOf(getNode(doc, parentId)) === 'page'
              ? null
              : frameOrDeclared(doc, geo, parentId, declared)
          // Virtual sizes may come from layout: freeze them like a flow item leaving its parent.
          const asFlow: ClipNode = { ...clip, context: 'flow' }
          clip = { ...clip, styles: placedStyles(doc, asFlow, parentId, frame, parentFrame) }
        }
      } else {
        const sub = toSubtreeSnapshot(doc, ref)
        clip = sub ? clipFromSnapshot(sub.nodes, ref) : null
        node = sub?.nodes[ref]
      }
      if (!clip || !node) continue
      const patch = opts.placeRoot?.(node as DesignNode) ?? null
      if (patch) {
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete clip.styles[k]
          else if (v !== undefined) clip.styles[k] = v
        }
      }
      out.push(createClip(doc, clip, parentId, index, { keepKeys, remap: {} }))
    }
    fitGroups(doc, out, geo)
    return out
  })
}
