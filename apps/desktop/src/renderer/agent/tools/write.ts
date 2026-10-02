/**
 * Write tools (contract §6.6, §6.7, §6.21–§6.23, §7): write_html, create_artboard, create_page,
 * rename_pages, update_styles. Every call does its async preparation (image sources, natural
 * sizes) first, then exactly one transaction with origin `agent:<tool>`.
 */
import {
  CONTAINER_NODE_TYPES,
  createNode,
  fitGroups,
  getNode,
  getTokens,
  isTreeId,
  resizeGroup,
  setNodeProps,
  setStyles,
  setStylesAt,
  type StylePatch,
  type StyleValue,
  type Styles,
} from '@baren/schema'
import { nextPageName } from '../../editor/model/docOps'
import { AgentToolError, entryError, type EntryError } from '../errors'
import { placeArtboard, toPx, UNKNOWN_HEIGHT, type Rect } from '../geometry'
import { html, type ApplyResult, type HtmlWarning, type IrNode } from '../html'
import { cssUrls, resolveImageSources, rewriteStyleUrls, type ImageEntry } from '../images'
import {
  artboardOfRef,
  assertUnlocked,
  componentName,
  displayName,
  isTopLevel,
  isVirtual,
  pageOfRef,
  requireRef,
  resolveRef,
} from '../model'
import {
  anchorKey,
  arr,
  commit,
  pageArg,
  rec,
  reqStr,
  str,
  type HostEnv,
  type ToolCall,
  type ToolOutput,
} from '../context'
import { treeSummary } from './read'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Deduplicate warnings by (code, property, path), keeping the first. */
export function dedupeWarnings(list: readonly HtmlWarning[]): HtmlWarning[] {
  const seen = new Set<string>()
  const out: HtmlWarning[] = []
  for (const w of list) {
    const key = `${w.code}\u0000${w.property ?? ''}\u0000${w.path ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}

/**
 * Placement for a new artboard on `pageId` (§6.21.1). `anchor` overrides the session anchor
 * (duplicates use their source). `measure: false` (the default, for use inside transactions)
 * reads declared or already measured sizes only; unknown heights count as 900.
 */
export function placeOnPage(
  call: ToolCall,
  pageId: string,
  size: { width: number; height: number },
  anchor: Rect | string | null = null,
  measure = false,
): { left: number; top: number } {
  const { env } = call
  const rects = env.geometry.topLevelRects(pageId, { measure })
  let a: Rect | null = null
  if (anchor && typeof anchor === 'object') a = anchor
  else {
    const id = typeof anchor === 'string' ? anchor : env.anchors.get(anchorKey(call, pageId))
    if (id !== undefined) a = rects.find((r) => r.id === id)?.rect ?? null
  }
  return placeArtboard(
    rects.map((r) => r.rect),
    a,
    size,
  )
}

/** Image sources used by parsed HTML: `<img src>` and CSS `url()`s; sources needing a size. */
function irSources(roots: readonly IrNode[]): { all: Set<string>; sized: Set<string> } {
  const all = new Set<string>()
  const sized = new Set<string>()
  const stack = [...roots]
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    for (const v of Object.values(n.styles)) {
      if (typeof v === 'string' && /url\(/i.test(v)) for (const u of cssUrls(v)) all.add(u)
    }
    if (n.kind === 'image') {
      all.add(n.src)
      const hasSize =
        (n.styles['width'] !== undefined && n.styles['width'] !== null) ||
        n.attrWidth !== null ||
        n.attrHeight !== null
      if (!hasSize) sized.add(n.src)
    }
    if (n.kind === 'frame') stack.push(...n.children)
  }
  return { all, sized }
}

/** Group children are always absolute in group-local coordinates (contract Phase 3 §2.5). */
function absolutizeInGroup(env: HostEnv, parentId: string, ids: readonly string[]): void {
  const parent = getNode(env.doc, parentId)
  if (!parent || parent.type !== 'group') return
  for (const id of ids) {
    const n = getNode(env.doc, id)
    if (!n) continue
    const patch: StylePatch = {}
    if (n.styles['position'] !== 'absolute') patch['position'] = 'absolute'
    if (n.styles['left'] === undefined) patch['left'] = 0
    if (n.styles['top'] === undefined) patch['top'] = 0
    if (Object.keys(patch).length > 0) setStyles(env.doc, id, patch)
  }
}

/** Contract §6.22 `createdNodes` entry (geometry measured after the commit). */
export function createdNode(env: HostEnv, id: string): Record<string, unknown> | null {
  const node = resolveRef(env, id)
  if (!node) return null
  const g = env.geometry.fields(id)
  return {
    id,
    name: displayName(env, node),
    component: componentName(env, node),
    parentId: node.parentId,
    worldX: g.worldX,
    worldY: g.worldY,
    width: g.width,
    height: g.height,
  }
}

// ---------------------------------------------------------------------------
// write_html
// ---------------------------------------------------------------------------

export async function writeHtml(call: ToolCall): Promise<ToolOutput> {
  const { env, args } = call
  const source = reqStr(args, 'html')
  const mode = str(args, 'mode') === 'replace' ? 'replace' : 'insert-children'
  const targetId = reqStr(args, 'targetNodeId')
  const target = requireRef(env, targetId)
  if (isVirtual(targetId)) {
    throw new AgentToolError(
      'instance_content',
      'The target is inside a component instance: its layers come from the main component. Edit the main component, or detach the instance first.',
    )
  }
  if (mode === 'replace') {
    if (target.type === 'page') {
      throw new AgentToolError(
        'invalid_target',
        'A page cannot be replaced; use mode "insert-children" to add artboards to it.',
      )
    }
    assertUnlocked(env, targetId)
  } else {
    if (!CONTAINER_NODE_TYPES.has(target.type)) {
      throw new AgentToolError(
        'invalid_target',
        `${componentName(env, target)} "${displayName(env, target)}" cannot contain children; use mode "replace" or target its parent.`,
      )
    }
    if (target.type !== 'page') assertUnlocked(env, targetId)
  }
  const tokens = getTokens(env.doc)
  const parsed = html.parseHtml(source, { tokens })
  const { all, sized } = irSources(parsed.roots)
  const images: Map<string, ImageEntry> = await resolveImageSources(call, all, sized)
  if (call.signal.aborted) throw new AgentToolError('cancelled', 'The request was cancelled.')

  const pageId = target.type === 'page' ? targetId : pageOfRef(env, targetId)
  const wasArtboard = target.type !== 'page' && isTopLevel(env, targetId)
  const insertsArtboards = target.type === 'page' || (mode === 'replace' && wasArtboard)
  const oldBoard = target.type === 'page' ? null : artboardOfRef(env, targetId)
  let lastPlaced: Rect | null = null
  let applied: ApplyResult | null = null
  commit(call, () => {
    const result = html.applyHtml(
      env.doc,
      parsed,
      { mode, targetId },
      {
        fileId: env.fileId,
        geometry: env.geometry.source({ measure: false }),
        resolver: env.resolver,
        tokens,
        image: (src) => images.get(src) ?? null,
        placeArtboard: (page, size) => {
          const h = size.height > 0 ? size.height : UNKNOWN_HEIGHT
          const at = placeOnPage(call, page, { width: size.width, height: h }, lastPlaced)
          lastPlaced = { x: at.left, y: at.top, width: size.width, height: h }
          return at
        },
      },
    )
    absolutizeInGroup(env, result.parentId, result.created)
    fitGroups(env.doc, result.created, env.geometry.source({ measure: false }))
    applied = result
  })
  const result = applied as ApplyResult | null
  if (!result) throw new AgentToolError('internal', 'write_html produced no result.')
  if (insertsArtboards && pageId && result.created.length > 0) {
    env.anchors.set(anchorKey(call, pageId), result.created[result.created.length - 1] as string)
  }
  const createdNodes = result.created
    .map((id) => createdNode(env, id))
    .filter((x): x is Record<string, unknown> => x !== null)
  const summary = result.created
    .filter((id) => resolveRef(env, id))
    .map((id) => treeSummary(env, id, 3))
    .join('\n')
  const touched = new Set<string>()
  for (const id of result.created) {
    const b = artboardOfRef(env, id)
    if (b) touched.add(b)
  }
  if (oldBoard && resolveRef(env, oldBoard)) touched.add(oldBoard)
  const body: Record<string, unknown> = { createdNodes, summary }
  if (result.replacedId) body['replacedNodeId'] = result.replacedId
  body['warnings'] = dedupeWarnings([...parsed.warnings, ...result.warnings])
  return { result: body, touched: [...touched] }
}

// ---------------------------------------------------------------------------
// create_artboard
// ---------------------------------------------------------------------------

const SIZE_RE = /^\s*(-?\d+(?:\.\d+)?)(px)?\s*$/i

function sizeArg(v: unknown, key: string): string | number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  if (typeof v === 'string') {
    if (v.trim() === 'fit-content') return 'fit-content'
    const m = SIZE_RE.exec(v)
    if (m && Number(m[1]) > 0) return `${Number(m[1])}px`
  }
  throw new AgentToolError(
    'invalid_argument',
    `styles.${key} must be a whole px size like "1440px" (or "fit-content"); got ${JSON.stringify(v)}.`,
  )
}

/** Image urls in tool styles → stored assets (main pre-resolved files and URLs). */
async function styleImages(
  call: ToolCall,
  styles: Record<string, unknown>,
): Promise<Map<string, ImageEntry>> {
  const sources = new Set<string>()
  for (const v of Object.values(styles)) {
    if (typeof v === 'string' && /url\(/i.test(v)) for (const u of cssUrls(v)) sources.add(u)
  }
  return sources.size === 0 ? new Map() : resolveImageSources(call, sources)
}

export async function createArtboard(call: ToolCall): Promise<ToolOutput> {
  const { env, args } = call
  const name = reqStr(args, 'name').trim().slice(0, 1024) || 'Artboard'
  const pageId = pageArg(env, str(args, 'pageId'))
  const raw = rec(args['styles'])
  const width = sizeArg(raw['width'], 'width')
  const height = sizeArg(raw['height'], 'height')
  const images = await styleImages(call, raw)
  if (call.signal.aborted) throw new AgentToolError('cancelled', 'The request was cancelled.')
  const rewritten = rewriteStyleUrls({ ...raw, width, height }, images)
  const tokens = getTokens(env.doc)
  const norm = html.normalizeStyles(rewritten.styles, { tokens })
  const styles: Styles = {}
  for (const [k, v] of Object.entries(norm.styles)) if (v !== null) styles[k] = v
  if (styles['display'] === undefined) styles['display'] = 'flex'
  if (styles['flexDirection'] === undefined) styles['flexDirection'] = 'column'
  if (
    styles['background'] === undefined &&
    styles['backgroundColor'] === undefined &&
    styles['backgroundImage'] === undefined
  ) {
    styles['backgroundColor'] = '#FFFFFF'
  }
  for (const k of ['position', 'right', 'bottom', 'inset']) delete styles[k]
  const w = toPx(styles['width']) ?? 1440
  const h = toPx(styles['height']) ?? UNKNOWN_HEIGHT
  if (toPx(styles['left']) === null || toPx(styles['top']) === null) {
    const at = placeOnPage(call, pageId, { width: w, height: h }, null, true)
    if (toPx(styles['left']) === null) styles['left'] = at.left
    if (toPx(styles['top']) === null) styles['top'] = at.top
  }
  let id = ''
  commit(call, () => {
    id = createNode(env.doc, { type: 'frame', parentId: pageId, name, styles })
  })
  env.anchors.set(anchorKey(call, pageId), id)
  const g = env.geometry.fields(id)
  return {
    result: {
      id,
      name,
      pageId,
      worldX: g.worldX,
      worldY: g.worldY,
      width: g.width,
      height: g.height,
      warnings: dedupeWarnings([...rewritten.warnings, ...norm.warnings]),
    },
    touched: [id],
  }
}

// ---------------------------------------------------------------------------
// create_page / rename_pages
// ---------------------------------------------------------------------------

export function createPageTool(call: ToolCall): ToolOutput {
  const { env, args } = call
  const name = (str(args, 'name') ?? '').trim().slice(0, 1024) || nextPageName(env.doc)
  let pageId = ''
  commit(call, () => {
    pageId = createNode(env.doc, { type: 'page', parentId: null, name, background: '#EEEEEE' })
  })
  return { result: { pageId, name } }
}

export function renamePages(call: ToolCall): ToolOutput {
  const { env, args } = call
  const errors: EntryError[] = []
  const valid: { pageId: string; name: string }[] = []
  arr(args, 'updates').forEach((raw, index) => {
    const u = rec(raw)
    const pageId = typeof u['pageId'] === 'string' ? u['pageId'] : ''
    const name = typeof u['name'] === 'string' ? u['name'].trim().slice(0, 1024) : ''
    const page = resolveRef(env, pageId)
    if (!page || page.type !== 'page') {
      errors.push({
        index,
        id: pageId,
        code: 'page_not_found',
        message: `Page ${JSON.stringify(pageId)} not found.`,
      })
      return
    }
    if (!name) {
      errors.push({
        index,
        id: pageId,
        code: 'invalid_argument',
        message: 'A page name cannot be empty.',
      })
      return
    }
    valid.push({ pageId, name })
  })
  if (valid.length === 0) return { result: { renamed: [], errors } }
  commit(call, () => {
    for (const v of valid) setNodeProps(env.doc, v.pageId, { name: v.name })
  })
  const body: Record<string, unknown> = { renamed: valid.map((v) => v.pageId) }
  if (errors.length > 0) body['errors'] = errors
  return { result: body }
}

// ---------------------------------------------------------------------------
// update_styles
// ---------------------------------------------------------------------------

const GROUP_INERT = new Set([
  'display',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'alignContent',
  'gap',
  'rowGap',
  'columnGap',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'paddingBlock',
  'paddingInline',
])

interface StyleUpdate {
  index: number
  ids: string[]
  patch: StylePatch
}

export async function updateStyles(call: ToolCall): Promise<ToolOutput> {
  const { env, args } = call
  const tokens = getTokens(env.doc)
  const updates = arr(args, 'updates').map((raw, index) => {
    const u = rec(raw)
    return {
      index,
      ids: (Array.isArray(u['nodeIds']) ? u['nodeIds'] : []).filter(
        (x): x is string => typeof x === 'string',
      ),
      styles: rec(u['styles']),
    }
  })
  // Image sources of every update first (async), then one transaction.
  const allStyles: Record<string, unknown> = {}
  updates.forEach((u, i) => {
    for (const [k, v] of Object.entries(u.styles)) allStyles[`${i}:${k}`] = v
  })
  const images = await styleImages(call, allStyles)
  if (call.signal.aborted) throw new AgentToolError('cancelled', 'The request was cancelled.')

  const warnings: HtmlWarning[] = []
  const errors: EntryError[] = []
  const prepared: StyleUpdate[] = []
  for (const u of updates) {
    const rewritten = rewriteStyleUrls(u.styles, images)
    warnings.push(...rewritten.warnings)
    // `null` and "" remove a property (extension).
    const input: Record<string, StyleValue | null> = {}
    for (const [k, v] of Object.entries(rewritten.styles)) input[k] = v === '' ? null : v
    const norm = html.normalizeStyles(input, { tokens })
    warnings.push(...norm.warnings)
    prepared.push({ index: u.index, ids: u.ids, patch: norm.styles })
  }

  const updated: string[] = []
  const ignoredStyles: Record<string, string[]> = {}
  const plan: {
    id: string
    patch: StylePatch
    group?: { width?: number; height?: number }
    pageBackground?: StyleValue | null
  }[] = []
  for (const u of prepared) {
    for (const id of u.ids) {
      try {
        const node = requireRef(env, id)
        assertUnlocked(env, id)
        const ignored: string[] = []
        if (node.type === 'page') {
          const bg = u.patch['backgroundColor'] ?? u.patch['background']
          for (const k of Object.keys(u.patch)) {
            if (k !== 'backgroundColor' && k !== 'background') ignored.push(k)
          }
          if (ignored.length > 0) ignoredStyles[id] = ignored
          if (bg !== undefined) plan.push({ id, patch: {}, pageBackground: bg })
          continue
        }
        const part = html.partitionStyles(u.patch, {
          type: node.type,
          styles: node.styles,
          isTopLevel: isTopLevel(env, id),
        })
        ignored.push(...part.ignored)
        const apply: StylePatch = { ...part.apply }
        let group: { width?: number; height?: number } | undefined
        if (node.type === 'group') {
          for (const k of Object.keys(apply)) {
            if (GROUP_INERT.has(k)) {
              ignored.push(k)
              delete apply[k]
            }
          }
          const w = toPx(apply['width'])
          const h = toPx(apply['height'])
          if (w !== null || h !== null) {
            group = {}
            if (w !== null) group.width = w
            if (h !== null) group.height = h
            delete apply['width']
            delete apply['height']
          }
        }
        if (ignored.length > 0) ignoredStyles[id] = [...new Set(ignored)]
        const full: StylePatch = { ...html.clearedFamilyKeys(apply, node.styles), ...apply }
        plan.push(group ? { id, patch: full, group } : { id, patch: full })
      } catch (error) {
        errors.push(entryError(u.index, id, error))
      }
    }
  }
  if (plan.length === 0 && errors.length > 0) {
    return { result: { updated: [], warnings: dedupeWarnings(warnings), errors } }
  }
  const touched = new Set<string>()
  commit(call, () => {
    const doc = env.doc
    const geo = env.geometry.source({ measure: false })
    for (const p of plan) {
      if (p.pageBackground !== undefined) {
        const bg = p.pageBackground
        setNodeProps(doc, p.id, { background: bg === null ? null : String(bg) })
        updated.push(p.id)
        continue
      }
      if (p.group) {
        const g = getNode(doc, p.id)
        if (g) {
          resizeGroup(doc, p.id, {
            width: p.group.width ?? toPx(g.styles['width']) ?? 0,
            height: p.group.height ?? toPx(g.styles['height']) ?? 0,
          })
        }
      }
      if (Object.keys(p.patch).length > 0) {
        if (isTreeId(p.id) && getNode(doc, p.id)?.type !== 'instance') setStyles(doc, p.id, p.patch)
        else setStylesAt(doc, p.id, p.patch, { resolver: env.resolver })
      }
      updated.push(p.id)
    }
    fitGroups(
      doc,
      plan.map((p) => p.id),
      geo,
    )
  })
  for (const id of updated) {
    const b = artboardOfRef(env, id)
    if (b) touched.add(b)
  }
  const body: Record<string, unknown> = { updated: [...new Set(updated)] }
  if (Object.keys(ignoredStyles).length > 0) body['ignoredStyles'] = ignoredStyles
  body['warnings'] = dedupeWarnings(warnings)
  if (errors.length > 0) body['errors'] = errors
  return { result: body, touched: [...touched] }
}
