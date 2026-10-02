/**
 * Theme tokens (artboard 07): grouping for the Theme panel, display names and values,
 * usage counting for "Used in", and naming rules. Pure, unit-tested.
 */
import type { DesignNode, Token } from '@baren/schema'
import { parseColor } from './colors'

export type TokenGroupId = 'colors' | 'typography' | 'spacing' | 'radius' | 'other'

export const TOKEN_GROUPS: readonly { id: TokenGroupId; label: string }[] = [
  { id: 'colors', label: 'Colors' },
  { id: 'typography', label: 'Typography' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'radius', label: 'Radius' },
  { id: 'other', label: 'Other' },
]

const TYPO_TYPES = new Set([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'typography',
])

export function tokenGroup(name: string, token: Pick<Token, 'type'>): TokenGroupId {
  const t = token.type
  if (t === 'color' || name.startsWith('--color-')) return 'colors'
  if (
    TYPO_TYPES.has(t) ||
    /^--(font|text|leading|tracking)-/.test(name) ||
    name.startsWith('--font-weight-')
  ) {
    return 'typography'
  }
  if (t === 'spacing' || name.startsWith('--spacing-')) return 'spacing'
  if (t === 'radius' || name.startsWith('--radius-')) return 'radius'
  return 'other'
}

/** Row label: colors drop their namespace ("background"); others keep it ("font-sans"). */
export function tokenDisplayName(name: string, group: TokenGroupId): string {
  if (group === 'colors' && name.startsWith('--color-')) return name.slice('--color-'.length)
  return name.replace(/^--/, '')
}

/** The namespace shown muted in the token name field ("--color-"). */
export function tokenNamespace(name: string): string {
  const m = /^(--[a-z]+-)/.exec(name)
  return m ? (m[1] as string) : '--'
}

/** Row value: colors as RRGGBB, font stacks as their first family, sizes as written. */
export function tokenDisplayValue(token: Token): string {
  const raw = String(token.value)
  const color = parseColor(raw)
  if (color?.kind === 'literal') return color.hex
  if (token.type === 'fontFamily' || /,/.test(raw)) {
    return (raw.split(',')[0] ?? raw).trim().replace(/^['"]|['"]$/g, '')
  }
  return raw
}

export interface TokenEntry {
  name: string
  token: Token
  group: TokenGroupId
  label: string
  value: string
}

export interface TokenGroupView {
  id: TokenGroupId
  label: string
  entries: TokenEntry[]
}

/**
 * Grouped and filtered token list. Within a group, tokens follow their `order` (kept in
 * each token entry; see TOKEN_ORDER_KEY), then their name — Loro map iteration order is
 * not insertion order, so without it the list would shuffle between peers.
 */
export function groupTokens(
  tokens: Record<string, Token>,
  query = '',
  orders: Readonly<Record<string, number>> = {},
): TokenGroupView[] {
  const q = query.trim().toLowerCase()
  const groups = new Map<TokenGroupId, TokenEntry[]>()
  const names = Object.keys(tokens).sort((a, b) => {
    const oa = orders[a] ?? Number.POSITIVE_INFINITY
    const ob = orders[b] ?? Number.POSITIVE_INFINITY
    return oa !== ob ? oa - ob : a < b ? -1 : a > b ? 1 : 0
  })
  for (const name of names) {
    const token = tokens[name] as Token
    const group = tokenGroup(name, token)
    const label = tokenDisplayName(name, group)
    const value = tokenDisplayValue(token)
    if (q && !name.toLowerCase().includes(q) && !value.toLowerCase().includes(q)) continue
    let list = groups.get(group)
    if (!list) groups.set(group, (list = []))
    list.push({ name, token, group, label, value })
  }
  return TOKEN_GROUPS.filter((g) => groups.has(g.id)).map((g) => ({
    id: g.id,
    label: g.label,
    entries: groups.get(g.id) ?? [],
  }))
}

/** Extra numeric key in a token's Loro map giving its position in the Theme panel. */
export const TOKEN_ORDER_KEY = 'order'

/** `order` of every token that has one, from the raw tokens map JSON. */
export function readTokenOrders(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null) continue
    const order = (entry as Record<string, unknown>)[TOKEN_ORDER_KEY]
    if (typeof order === 'number' && Number.isFinite(order)) out[name] = order
  }
  return out
}

/** Next order value after every existing one. */
export function nextTokenOrder(orders: Readonly<Record<string, number>>): number {
  let max = 0
  for (const v of Object.values(orders)) max = Math.max(max, v)
  return max + 1
}

const NAME_RE = /^--[A-Za-z0-9_-]+$/

/** Normalise a user-typed name into a CSS custom property name, or null if invalid. */
export function normalizeTokenName(input: string, namespace: string): string | null {
  let s = input.trim().replace(/\s+/g, '-')
  if (!s.startsWith('--')) s = namespace + s.replace(/^-+/, '')
  return NAME_RE.test(s) ? s : null
}

export function uniqueTokenName(base: string, existing: Record<string, unknown>): string {
  if (!(base in existing)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!(candidate in existing)) return candidate
  }
}

export type UsageKind = 'fill' | 'text' | 'border' | 'outline' | 'shadow' | 'other'

const USAGE_OF: Record<string, UsageKind> = {
  backgroundColor: 'fill',
  backgroundImage: 'fill',
  background: 'fill',
  fill: 'fill',
  color: 'text',
  fontFamily: 'text',
  fontSize: 'text',
  fontWeight: 'text',
  lineHeight: 'text',
  letterSpacing: 'text',
  outline: 'outline',
  outlineColor: 'outline',
  boxShadow: 'shadow',
  textShadow: 'shadow',
}

function usageKind(prop: string): UsageKind {
  const k = USAGE_OF[prop]
  if (k) return k
  if (prop.startsWith('border') && !prop.endsWith('Radius')) return 'border'
  return 'other'
}

export interface TokenUsage {
  layers: number
  artboards: number
  byKind: { kind: UsageKind; count: number }[]
  nodeIds: string[]
}

/** Count layers that reference `var(<token>)`, per property kind and per artboard. */
export class TokenUsageCounter {
  private readonly needle: RegExp
  private readonly kinds = new Map<UsageKind, number>()
  private readonly artboards = new Set<string>()
  readonly nodeIds: string[] = []

  constructor(token: string) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    this.needle = new RegExp(`var\\(\\s*${escaped}\\s*[,)]`)
  }

  /** Feed one artboard subtree (or any batch of nodes belonging to `artboardId`). */
  add(artboardId: string, nodes: Iterable<DesignNode>): void {
    for (const node of nodes) {
      let used = false
      for (const [prop, value] of Object.entries(node.styles)) {
        if (typeof value !== 'string' || !this.needle.test(value)) continue
        const kind = usageKind(prop)
        this.kinds.set(kind, (this.kinds.get(kind) ?? 0) + 1)
        used = true
      }
      if (used) {
        this.nodeIds.push(node.id)
        this.artboards.add(artboardId)
      }
    }
  }

  result(): TokenUsage {
    const order: UsageKind[] = ['fill', 'outline', 'border', 'shadow', 'text', 'other']
    return {
      layers: this.nodeIds.length,
      artboards: this.artboards.size,
      byKind: order
        .filter((k) => (this.kinds.get(k) ?? 0) > 0)
        .map((kind) => ({ kind, count: this.kinds.get(kind) ?? 0 })),
      nodeIds: [...this.nodeIds],
    }
  }
}
