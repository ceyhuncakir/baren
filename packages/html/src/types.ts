/**
 * Public types of `@baren/html` (docs/phase4/contract.md §12). DOM-free: this package is
 * bundled into the Electron main process (whose TS lib has no DOM) and the renderer.
 */
import type { GeometrySource, ComponentResolver, StylePatch, Styles, Token } from '@baren/schema'

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

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
  /** Element path like `div[2] > p[1]` (1-based among the element siblings of the fragment). */
  path?: string
  /** camelCase style property (or attribute name for `attribute-ignored`). */
  property?: string
}

// ---------------------------------------------------------------------------
// Parse (no Loro)
// ---------------------------------------------------------------------------

export interface IrBase {
  /** Layer name; null = the applier picks the default (images: source name, else "Image"). */
  name: string | null
  /** Normalised styles (`null` entries are resets; the applier drops them on creation). */
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
  | (IrBase & { kind: 'svg'; markup: string }) // sanitised
  | (IrBase & { kind: 'clone'; nodeId: string })

export interface ParsedHtml {
  roots: IrNode[]
  warnings: HtmlWarning[]
  /** Nodes the HTML creates (a clone counts as one; the applier adds the copies' sizes). */
  nodeCount: number
}

export interface ParseOptions {
  /** The file's tokens; when given, unknown `var(--x)` references are reported. */
  tokens?: Record<string, Token>
  /** Default 5000. Elements beyond it are not converted (`nodeCount` keeps counting). */
  maxNodes?: number
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

export interface NormalizeResult {
  styles: StylePatch
  warnings: HtmlWarning[]
}

/** What an image source resolved to (main pre-resolves files and URLs; §4.8). */
export type ResolvedImage =
  | {
      kind: 'raster'
      hash: string
      mime: string
      name: string
      /** Natural size in px when known (the runtime decodes the image). */
      width: number | null
      height: number | null
    }
  | { kind: 'svg'; markup: string; name: string }

/** `null` = not a known source. */
export type ImageLookup = (src: string) => ResolvedImage | { error: string } | null

export interface NormalizeContext {
  tokens?: Record<string, Token>
  /** Custom properties declared elsewhere in the same call (they are not unknown tokens). */
  localVars?: ReadonlySet<string>
  path?: string
  /**
   * Extension: resolve `url(…)` sources in image properties right away (update_styles,
   * create_artboard). Without it, urls are kept for `applyHtml` / `resolveStyleImages`.
   */
  image?: ImageLookup
}

// ---------------------------------------------------------------------------
// Apply (Loro; never commits — call inside transact)
// ---------------------------------------------------------------------------

export interface ApplyContext {
  fileId: string
  geometry: GeometrySource
  resolver: ComponentResolver
  tokens: Record<string, Token>
  image: ImageLookup
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
  /** The new top-level nodes, in order. */
  created: string[]
  /** Their parent (the target, or the target's parent in replace mode). */
  parentId: string
  replacedId: string | null
  /** Parse warnings plus apply warnings, deduplicated by (code, property, path). */
  warnings: HtmlWarning[]
}

export type HtmlApplyErrorCode =
  'node_not_found' | 'invalid_target' | 'instance_content' | 'cycle' | 'too_large'

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface JsxOptions {
  format: 'tailwind' | 'inline-styles'
  tokens: Record<string, Token>
  /** Inherited text properties the root does not set itself (nearest ancestor's value). */
  inherited?: Styles
  /** Adds `data-node-id` attributes. */
  includeIds?: boolean
  /** Default `baren-asset://<hash>`. */
  assetUrl?: (hash: string) => string
  /**
   * Extension: the root is a top-level node (an artboard), so its `left`/`top`/`position`
   * are dropped. Default: detected (root has `left`/`top`, no `position`, parent absent).
   */
  topLevel?: boolean
}

export interface StageOptions {
  tokens: Record<string, Token>
  inherited?: Styles
  /** Measured size of the root; null = layout in the stage. */
  size?: { width: number; height: number } | null
  /** Screenshot compositing colour; null = transparent (exports). */
  background?: string | null
  assetUrl?: (hash: string) => string
}

export interface RenderStage {
  /** One `<div data-baren-stage>` wrapper holding the node's HTML (`data-node-id`s). */
  html: string
  /** Shadow-root stylesheet: `:host` tokens, canvas base rules, the root's upright rule. */
  css: string
  /** Asset URLs to preload (image layers and image fills), in document order. */
  assetUrls: string[]
}
