/**
 * find_nodes (contract §6.12): style and text search over the rendered tree (instance
 * content included), on canonical declared styles (§8.2). Filters and textValue combine with
 * AND; each filter needs one style entry matching both its name and value patterns.
 */
import {
  getChildIds,
  getTokens,
  isTreeId,
  type ResolvedNode,
  type StyleValue,
  type Token,
} from '@baren/schema'
import { AgentToolError } from '../errors'
import { html } from '../html'
import { componentName, displayName, requireRef, resolveRef } from '../model'
import { arr, rec, str, type HostEnv, type ToolCall, type ToolOutput } from '../context'

export const FIND_LIMIT = 500

export interface StyleFilter {
  styleName?: string
  styleValue?: string
}

export type Match = { styleName: string; styleValue: string } | { textValue: string }

function kebab(key: string): string {
  if (key.startsWith('--')) return key
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^(webkit|moz|ms)-/, '-$1-')
}

const TOKEN_RE = /^(?:var\(\s*)?(--[A-Za-z0-9_-]+)\s*\)?$/
/** Colour literals inside a composite value (hex, rgb/hsl/oklch/oklab/hwb/lab/lch functions). */
const COLOR_FRAGMENT_RE =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)|\b(?:transparent|white|black|red|green|blue|gray|grey|orange|yellow|purple|pink)\b/g
const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g

/** A token's final value through `var()` aliases (≤ 8 hops). */
export function resolveTokenValue(name: string, tokens: Record<string, Token>): string | null {
  let cur: string | null = name
  for (let i = 0; i < 8 && cur !== null; i++) {
    const token: Token | undefined = tokens[cur]
    if (!token) return null
    const v = String(token.value).trim()
    const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[\s\S]*)?\)$/.exec(v)
    if (!m) return v
    cur = m[1] ?? null
  }
  return null
}

export interface ValueMatcher {
  /** The matched text (whole value or fragment), or null. */
  (value: string): string | null
}

/** Compile a `styleValue` pattern (contract §6.12). */
export function valueMatcher(pattern: string, tokens: Record<string, Token>): ValueMatcher {
  const p = pattern.trim()
  const token = TOKEN_RE.exec(p)
  if (token) {
    const name = token[1] as string
    return (value) => {
      VAR_RE.lastIndex = 0
      for (let m = VAR_RE.exec(value); m !== null; m = VAR_RE.exec(value)) {
        if (m[1] === name) return value.trim() === m[0] ? value : m[0]
      }
      return null
    }
  }
  const color = html.parseCssColor(p)
  if (color) {
    return (value) => {
      const v = value.trim()
      if (html.parseCssColor(v) && html.colorsEqual(v, p)) return value
      COLOR_FRAGMENT_RE.lastIndex = 0
      for (let m = COLOR_FRAGMENT_RE.exec(v); m !== null; m = COLOR_FRAGMENT_RE.exec(v)) {
        const frag = m[0]
        if (html.parseCssColor(frag) && html.colorsEqual(frag, p)) return v === frag ? value : frag
      }
      VAR_RE.lastIndex = 0
      for (let m = VAR_RE.exec(v); m !== null; m = VAR_RE.exec(v)) {
        const resolved = resolveTokenValue(m[1] as string, tokens)
        if (resolved !== null && html.parseCssColor(resolved) && html.colorsEqual(resolved, p)) {
          return m[0]
        }
      }
      return null
    }
  }
  return (value) => (html.wildcardMatch(p, value.trim(), { caseInsensitive: true }) ? value : null)
}

export interface CompiledFilter {
  name: ((key: string) => boolean) | null
  value: ValueMatcher | null
}

export function compileFilter(f: StyleFilter, tokens: Record<string, Token>): CompiledFilter {
  const namePattern = f.styleName?.trim()
  const valuePattern = f.styleValue?.trim()
  return {
    name:
      namePattern && namePattern !== '*'
        ? (key) =>
            html.wildcardMatch(namePattern, key, { caseInsensitive: true }) ||
            html.wildcardMatch(namePattern, kebab(key), { caseInsensitive: true })
        : null,
    value: valuePattern && valuePattern !== '*' ? valueMatcher(valuePattern, tokens) : null,
  }
}

function asText(v: StyleValue): string {
  return typeof v === 'number' ? String(v) : v
}

/** The style entries of `styles` satisfying `filter` (empty: no match). */
export function matchFilter(
  styles: Record<string, StyleValue>,
  filter: CompiledFilter,
): { styleName: string; styleValue: string }[] {
  const out: { styleName: string; styleValue: string }[] = []
  for (const key of Object.keys(styles)) {
    if (filter.name && !filter.name(key)) continue
    const value = asText(styles[key] as StyleValue)
    if (filter.value) {
      const hit = filter.value(value)
      if (hit === null) continue
      out.push({ styleName: key, styleValue: hit })
    } else out.push({ styleName: key, styleValue: value })
  }
  return out
}

export interface FindQuery {
  filters: StyleFilter[]
  textValue?: string
}

/** Matches of one node, or null when it does not satisfy every filter and the text pattern. */
export function matchNode(
  node: ResolvedNode,
  compiled: readonly CompiledFilter[],
  textValue: string | undefined,
): Match[] | null {
  const matched: Match[] = []
  if (compiled.length > 0) {
    const styles = html.canonicalStyles(node)
    const seen = new Set<string>()
    for (const f of compiled) {
      const hits = matchFilter(styles, f)
      if (hits.length === 0) return null
      for (const h of hits) {
        const k = `${h.styleName}\u0000${h.styleValue}`
        if (seen.has(k)) continue
        seen.add(k)
        matched.push(h)
      }
    }
  }
  if (textValue !== undefined) {
    if (node.type !== 'text') return null
    const text = node.text ?? ''
    if (!html.wildcardMatch(textValue, text, { caseInsensitive: true })) return null
    matched.push({ textValue: text })
  }
  return matched
}

export function findNodes(call: ToolCall): ToolOutput {
  const { env, args } = call
  const filters = arr(args, 'filters').map((f) => {
    const r = rec(f)
    const out: StyleFilter = {}
    if (typeof r['styleName'] === 'string') out.styleName = r['styleName']
    if (typeof r['styleValue'] === 'string') out.styleValue = r['styleValue']
    return out
  })
  const textValue = str(args, 'textValue')
  if (filters.length === 0 && (textValue === undefined || textValue === '')) {
    throw new AgentToolError(
      'invalid_argument',
      'Pass filters (styleName/styleValue) and/or textValue to search for.',
    )
  }
  const nodeId = str(args, 'nodeId')
  const pageId = str(args, 'pageId')
  let roots: string[]
  if (nodeId !== undefined && nodeId !== '') {
    requireRef(env, nodeId)
    roots = [nodeId]
  } else if (pageId !== undefined && pageId !== '') {
    const page = resolveRef(env, pageId)
    if (!page || page.type !== 'page') {
      throw new AgentToolError('page_not_found', `Page ${JSON.stringify(pageId)} not found.`)
    }
    roots = [pageId]
  } else roots = getChildIds(env.doc, null)
  const result = searchNodes(env, roots, { filters, ...(textValue ? { textValue } : {}) })
  return result
}

/**
 * Pre-order walk (document order) of the rendered tree under `root`: real nodes from the
 * document mirror, instance content through the resolver. `visit` returning false skips the
 * node's children.
 */
function walkRendered(env: HostEnv, root: string, visit: (node: ResolvedNode) => boolean): void {
  const index = env.index.map()
  const stack = [root]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    let node: ResolvedNode | undefined = isTreeId(id) ? index.get(id) : env.resolver.resolveNode(id)
    if (node?.type === 'instance') node = env.resolver.resolveNode(id) ?? node
    if (!node) continue
    if (!visit(node)) continue
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as string)
  }
}

/** Search `roots` (pre-order, document order). */
export function searchNodes(env: HostEnv, roots: readonly string[], q: FindQuery): ToolOutput {
  const tokens = getTokens(env.doc)
  const compiled = q.filters
    .filter((f) => (f.styleName ?? '') !== '' || (f.styleValue ?? '') !== '')
    .map((f) => compileFilter(f, tokens))
  const nodes: Record<string, unknown>[] = []
  let truncated = false
  for (const root of roots) {
    if (truncated) break
    walkRendered(env, root, (node) => {
      if (truncated) return false
      if (node.type === 'page') return true
      const matched = matchNode(node, compiled, q.textValue)
      if (matched) {
        if (nodes.length >= FIND_LIMIT) {
          truncated = true
          return false
        }
        nodes.push({
          id: node.id,
          name: displayName(env, node),
          component: componentName(env, node),
          matched,
        })
      }
      return true
    })
  }
  const body: Record<string, unknown> = { nodes, count: nodes.length }
  if (truncated) body['truncated'] = true
  // A search does not renew working indicators: no `touched`.
  return { result: body }
}
