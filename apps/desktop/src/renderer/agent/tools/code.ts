/**
 * Code export tools (contract §6.13, §6.14, §6.18): get_jsx, get_computed_styles, get_tokens.
 * Deterministic output through `@baren/html` (toJsx, canonicalStyles, tokensToCss).
 */
import { getTokens, toRenderSubtree, type Styles, type Token } from '@baren/schema'
import { AgentToolError, type EntryError } from '../errors'
import { html } from '../html'
import { artboardOfRef, requireRef, resolveRef } from '../model'
import { arr, bool, str, reqStr, type HostEnv, type ToolCall, type ToolOutput } from '../context'
import { assertNotPage, orderedTokenNames } from './read'

export const MAX_JSX_BYTES = 300 * 1024

/**
 * INHERITED_TEXT_PROPERTIES the node inherits from its ancestors and does not set itself
 * (nearest ancestor's declared value), so an exported root renders standalone.
 */
export function inheritedStyles(env: HostEnv, ref: string): Styles {
  const node = resolveRef(env, ref)
  const out: Styles = {}
  if (!node) return out
  const wanted = html.INHERITED_TEXT_PROPERTIES.filter((k) => node.styles[k] === undefined)
  if (wanted.length === 0) return out
  const missing = new Set(wanted)
  for (let cur = node.parentId; cur !== null && missing.size > 0;) {
    const parent = resolveRef(env, cur)
    if (!parent || parent.type === 'page') break
    for (const key of [...missing]) {
      const v = parent.styles[key]
      if (v !== undefined) {
        out[key] = v
        missing.delete(key)
      }
    }
    cur = parent.parentId
  }
  return out
}

export function getJsx(call: ToolCall): ToolOutput {
  const { env, args } = call
  const nodeId = reqStr(args, 'nodeId')
  const node = requireRef(env, nodeId)
  assertNotPage(node, 'get_jsx')
  const format = str(args, 'format') === 'inline-styles' ? 'inline-styles' : 'tailwind'
  const sub = toRenderSubtree(env.doc, nodeId, env.resolver)
  if (!sub) throw new AgentToolError('node_not_found', `Node ${JSON.stringify(nodeId)} not found.`)
  const jsx = html.toJsx(sub.nodes, nodeId, {
    format,
    tokens: getTokens(env.doc),
    inherited: inheritedStyles(env, nodeId),
    includeIds: bool(args, 'includeIds') === true,
  })
  if (jsx.length > MAX_JSX_BYTES) {
    throw new AgentToolError(
      'too_large',
      `The JSX of this node is ${Math.round(jsx.length / 1024)} KB (limit 300 KB). Ask for a child node instead (get_children lists them).`,
    )
  }
  const board = artboardOfRef(env, nodeId)
  return { result: jsx, touched: board ? [board] : [] }
}

export function getComputedStyles(call: ToolCall): ToolOutput {
  const { env, args } = call
  const ids = arr(args, 'nodeIds').filter((x): x is string => typeof x === 'string')
  const resolved = bool(args, 'resolved') === true
  const styles: Record<string, Record<string, string | number>> = {}
  const errors: EntryError[] = []
  const touched = new Set<string>()
  const byBoard = new Map<string, string[]>()
  ids.forEach((id, index) => {
    const node = resolveRef(env, id)
    if (!node) {
      errors.push({
        index,
        id,
        code: 'node_not_found',
        message: `Node ${JSON.stringify(id)} not found.`,
      })
      return
    }
    if (node.type === 'page') {
      errors.push({ index, id, code: 'invalid_target', message: 'A page has no CSS styles.' })
      return
    }
    const board = artboardOfRef(env, id)
    if (board) touched.add(board)
    if (!resolved) {
      styles[id] = html.canonicalStyles(node)
      return
    }
    if (board === null) return
    const list = byBoard.get(board) ?? []
    list.push(id)
    byBoard.set(board, list)
  })
  if (resolved) {
    if (!env.resolvedStyles) {
      throw new AgentToolError('unsupported', 'Resolved styles are not available in this host.')
    }
    for (const [board, list] of byBoard) {
      const out = env.resolvedStyles(board, list)
      for (const id of list) {
        const s = out?.[id]
        if (s) styles[id] = s
        else
          errors.push({
            index: ids.indexOf(id),
            id,
            code: 'invalid_target',
            message: 'The node is not rendered (hidden, or inside a hidden layer).',
          })
      }
    }
  }
  const body: Record<string, unknown> = { styles }
  if (errors.length > 0) body['errors'] = errors
  return { result: body, touched: [...touched] }
}

/** Case-insensitive glob on the full token name (`*` wildcard). */
function tokenNameMatches(pattern: string | undefined, name: string): boolean {
  if (pattern === undefined || pattern === '' || pattern === '*') return true
  return html.wildcardMatch(pattern, name, { caseInsensitive: true })
}

export function getTokensTool(call: ToolCall): ToolOutput {
  const { env, args } = call
  const format = str(args, 'format') ?? 'json'
  const namePattern = str(args, 'namePattern')
  const types = arr(args, 'types').filter((x): x is string => typeof x === 'string')
  const all = getTokens(env.doc)
  const names = orderedTokenNames(all, env.tokenOrders()).filter((name) => {
    const t = all[name] as Token
    if (!tokenNameMatches(namePattern, name)) return false
    return types.length === 0 || types.includes(t.type)
  })
  if (format === 'css' || format === 'tailwind') {
    const subset: Record<string, Token> = {}
    for (const n of names) subset[n] = all[n] as Token
    return { result: html.tokensToCss(subset, names, format) }
  }
  return {
    result: {
      tokens: names.map((name) => {
        const t = all[name] as Token
        const out: Record<string, unknown> = { name, type: t.type, value: t.value }
        if (t.description !== undefined && t.description !== '') out['description'] = t.description
        return out
      }),
    },
  }
}
