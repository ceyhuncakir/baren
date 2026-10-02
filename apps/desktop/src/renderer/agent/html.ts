/**
 * The runtime's view of `@baren/html` (contract §12): the exact signatures the executors
 * use. The package is implemented by the html workstream; this module is the one place the
 * runtime imports it.
 */
import * as pkg from '@baren/html'
import type {
  ComponentResolver,
  DesignNode,
  GeometrySource,
  NodeType,
  ResolvedNode,
  StylePatch,
  StyleValue,
  Styles,
  Token,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

export type HtmlWarningCode =
  | 'unsupported-element'
  | 'stylesheet-ignored'
  | 'class-ignored'
  | 'attribute-ignored'
  | 'unknown-property'
  | 'unsupported-property'
  | 'unsafe-value'
  | 'discouraged-property'
  | 'position-converted'
  | 'table-as-flex'
  | 'list-markers-dropped'
  | 'rich-text-flattened'
  | 'block-flow'
  | 'image-unresolved'
  | 'unknown-token'
  | 'clone-not-found'
  | 'clone-children-ignored'
  | 'artboard-size-defaulted'
  | 'depth-limit'

export interface HtmlWarning {
  code: HtmlWarningCode
  message: string
  path?: string
  property?: string
}

export interface IrBase {
  name: string | null
  styles: StylePatch
  hidden: boolean
  path: string
}

export type IrNode =
  | (IrBase & { kind: 'frame'; children: IrNode[] })
  | (IrBase & { kind: 'text'; text: string })
  | (IrBase & {
      kind: 'image'
      src: string
      alt: string | null
      attrWidth: number | null
      attrHeight: number | null
    })
  | (IrBase & { kind: 'svg'; markup: string })
  | (IrBase & { kind: 'clone'; nodeId: string })

export interface ParsedHtml {
  roots: IrNode[]
  warnings: HtmlWarning[]
  nodeCount: number
}

export interface NormalizeResult {
  styles: StylePatch
  warnings: HtmlWarning[]
}

export type ResolvedImage =
  | {
      kind: 'raster'
      hash: string
      mime: string
      name: string
      width: number | null
      height: number | null
    }
  | { kind: 'svg'; markup: string; name: string }

export interface ApplyContext {
  fileId: string
  geometry: GeometrySource
  resolver: ComponentResolver
  tokens: Record<string, Token>
  image(src: string): ResolvedImage | { error: string } | null
  placeArtboard(
    pageId: string,
    size: { width: number; height: number },
  ): { left: number; top: number }
  random?: () => number
}

export interface ApplyTarget {
  mode: 'insert-children' | 'replace'
  targetId: string
}

export interface ApplyResult {
  created: string[]
  parentId: string
  replacedId: string | null
  warnings: HtmlWarning[]
}

export interface JsxOptions {
  format: 'tailwind' | 'inline-styles'
  tokens: Record<string, Token>
  inherited?: Styles
  includeIds?: boolean
  assetUrl?: (hash: string) => string
}

export interface StageOptions {
  tokens: Record<string, Token>
  inherited?: Styles
  size?: { width: number; height: number } | null
  background?: string | null
  assetUrl?: (hash: string) => string
}

export interface RenderStage {
  html: string
  css: string
  assetUrls: string[]
}

export interface HtmlApi {
  parseHtml(html: string, opts?: { tokens?: Record<string, Token>; maxNodes?: number }): ParsedHtml
  collectImageSources(html: string): string[]
  collectCssUrls(styles: Record<string, StyleValue | null>): string[]
  normalizeStyles(
    input: string | Record<string, StyleValue | null>,
    ctx?: { tokens?: Record<string, Token>; localVars?: ReadonlySet<string>; path?: string },
  ): NormalizeResult
  clearedFamilyKeys(patch: StylePatch, existing: Styles): StylePatch
  partitionStyles(
    patch: StylePatch,
    ctx: { type: NodeType; styles: Styles; isTopLevel: boolean },
  ): { apply: StylePatch; ignored: string[] }
  canonicalStyles(node: Pick<DesignNode, 'type' | 'styles'>): Styles
  readonly INHERITED_TEXT_PROPERTIES: readonly string[]
  readonly KNOWN_CSS_PROPERTIES: ReadonlySet<string>
  rewriteTokenRefs(value: StyleValue, from: string, to: string): StyleValue
  tokensHash(tokens: Record<string, Token>): string
  parseCssColor(value: string): { r: number; g: number; b: number; a: number } | null
  colorsEqual(a: string, b: string): boolean
  wildcardMatch(pattern: string, value: string, opts?: { caseInsensitive?: boolean }): boolean
  applyHtml(doc: LoroDoc, parsed: ParsedHtml, target: ApplyTarget, ctx: ApplyContext): ApplyResult
  toJsx(nodes: Record<string, ResolvedNode>, rootId: string, opts: JsxOptions): string
  tokensToCss(
    tokens: Record<string, Token>,
    order: readonly string[],
    format: 'css' | 'tailwind',
  ): string
  renderStage(nodes: Record<string, ResolvedNode>, rootId: string, opts: StageOptions): RenderStage
}

/**
 * `@baren/html`, checked against the contract's signatures at compile time (the package may
 * add extensions; it must not narrow what the runtime relies on).
 */
export const html: HtmlApi = pkg
