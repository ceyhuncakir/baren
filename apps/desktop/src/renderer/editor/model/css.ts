/**
 * Styles → CSS text and node subtrees → JSX, for "Copy as" (artboard 15) and the
 * thumbnail renderer. Follows the canvas conventions (canvas-engine contract notes):
 * numbers become px except React's unitless properties, every node is border-box,
 * text nodes are `white-space: pre-wrap`. Pure, unit-tested.
 */
import { vectorToPathD, type DesignNode, type StyleValue, type Styles } from '@baren/schema'
import { HIDDEN_PREFIX } from './effects'

/** React's unitless CSS properties (camelCase). */
const UNITLESS = new Set([
  'animationIterationCount',
  'aspectRatio',
  'borderImageOutset',
  'borderImageSlice',
  'borderImageWidth',
  'boxFlex',
  'boxFlexGroup',
  'boxOrdinalGroup',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexPositive',
  'flexShrink',
  'flexNegative',
  'flexOrder',
  'gridArea',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'fontWeight',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'scale',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
])

export function isUnitless(prop: string): boolean {
  return UNITLESS.has(prop)
}

/** camelCase → kebab-case (vendor prefixes: WebkitX → -webkit-x). Custom properties kept. */
export function kebab(prop: string): string {
  if (prop.startsWith('--')) return prop
  const k = prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
  return /^(webkit|moz|ms)-/.test(k) ? `-${k}` : k
}

export function cssValue(prop: string, value: StyleValue): string {
  // A numeric rotation is degrees (contract §2.3), never px.
  if (prop === 'rotate' && typeof value === 'number') return `${value}deg`
  if (typeof value === 'number')
    return isUnitless(prop) || value === 0 ? String(value) : `${value}px`
  return value
}

/** Declarations to emit for a node, skipping editor-internal custom properties. */
export function cssEntries(styles: Styles): [string, string][] {
  const out: [string, string][] = []
  for (const [prop, value] of Object.entries(styles)) {
    if (prop.startsWith(HIDDEN_PREFIX)) continue
    // Values that could break out of a declaration are dropped.
    const text = cssValue(prop, value)
    if (/[;{}<>]/.test(text)) continue
    out.push([kebab(prop), text])
  }
  return out
}

/** `prop: value;` lines for "Copy as CSS". */
export function toCss(
  node: Pick<DesignNode, 'name' | 'styles' | 'type'>,
  selector?: string,
): string {
  const entries = cssEntries(node.styles)
  if (node.type === 'text' && !node.styles['whiteSpace']) entries.push(['white-space', 'pre-wrap'])
  const sel = selector ?? `.${slug(node.name) || 'layer'}`
  return `${sel} {\n${entries.map(([p, v]) => `  ${p}: ${v};`).join('\n')}\n}\n`
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function jsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

function jsxStyle(styles: Styles, extra: Record<string, string> = {}): string {
  const parts: string[] = []
  for (const [prop, value] of Object.entries(styles)) {
    if (prop.startsWith(HIDDEN_PREFIX)) continue
    const key = /^[A-Za-z_$][\w$]*$/.test(prop) ? prop : jsString(prop)
    parts.push(`${key}: ${typeof value === 'number' ? value : jsString(value)}`)
  }
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}: ${jsString(v)}`)
  return parts.length === 0 ? '' : ` style={{ ${parts.join(', ')} }}`
}

function jsxText(text: string): string {
  if (text === '') return ''
  return /[{}<>]/.test(text) || /^\s|\s$/.test(text) ? `{${jsString(text)}}` : text
}

/**
 * JSX for a subtree. `nodes` must contain every descendant of `rootId` (as returned by
 * `toSubtreeSnapshot`). Images reference their asset through `assetUrl`.
 */
export function toJsx(
  nodes: Record<string, DesignNode>,
  rootId: string,
  assetUrl: (assetId: string) => string = (id) => `baren-asset://${id}`,
): string {
  const lines: string[] = []
  const walk = (id: string, depth: number) => {
    const node = nodes[id]
    if (!node || node.hidden) return
    const pad = '  '.repeat(depth)
    const comment = `${pad}{/* ${node.name.replace(/\*\//g, '* /')} */}`
    switch (node.type) {
      case 'text':
        lines.push(comment)
        lines.push(
          `${pad}<p${jsxStyle(node.styles, node.styles['whiteSpace'] ? {} : { whiteSpace: 'pre-wrap' })}>${jsxText(node.text ?? '')}</p>`,
        )
        return
      case 'image':
        lines.push(
          `${pad}<img alt=${JSON.stringify(node.name)} src=${JSON.stringify(node.assetId ? assetUrl(node.assetId) : '')}${jsxStyle(node.styles)} />`,
        )
        return
      case 'svg':
        lines.push(
          `${pad}<div${jsxStyle(node.styles)} dangerouslySetInnerHTML={{ __html: ${jsString(node.svg ?? '')} }} />`,
        )
        return
      case 'vector': {
        const w = typeof node.styles['width'] === 'number' ? node.styles['width'] : 0
        const h = typeof node.styles['height'] === 'number' ? node.styles['height'] : 0
        const d = node.vector ? vectorToPathD(node.vector) : ''
        const rule = node.vector?.fillRule ?? 'nonzero'
        lines.push(comment)
        lines.push(
          `${pad}<svg width={${w}} height={${h}} viewBox="0 0 ${w} ${h}" overflow="visible"${jsxStyle(node.styles)}>`,
        )
        lines.push(`${pad}  <path d=${JSON.stringify(d)} fillRule=${JSON.stringify(rule)} />`)
        lines.push(`${pad}</svg>`)
        return
      }
      default: {
        const children = node.children.filter((c) => nodes[c] && !nodes[c]?.hidden)
        if (children.length === 0) {
          lines.push(`${pad}<div${jsxStyle(node.styles)} />`)
          return
        }
        lines.push(`${pad}<div${jsxStyle(node.styles)}>`)
        for (const c of children) walk(c, depth + 1)
        lines.push(`${pad}</div>`)
      }
    }
  }
  walk(rootId, 0)
  return `${lines.join('\n')}\n`
}
