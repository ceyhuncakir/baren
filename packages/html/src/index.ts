/**
 * `@baren/html` — HTML/CSS ↔ document conversion for the MCP tools (docs/phase4/contract.md
 * §7, §8, §12). DOM-free: imported by Electron main (`collectImageSources`, `collectCssUrls`)
 * and by the renderer (everything else). Nothing here commits: `applyHtml` runs inside the
 * caller's `transact`.
 */
export type {
  HtmlWarningCode,
  HtmlWarning,
  IrBase,
  IrNode,
  ParsedHtml,
  ParseOptions,
  NormalizeResult,
  NormalizeContext,
  ImageLookup,
  ResolvedImage,
  ApplyContext,
  ApplyTarget,
  ApplyResult,
  HtmlApplyErrorCode,
  JsxOptions,
  StageOptions,
  RenderStage,
} from './types.ts'

// parse (no Loro)
export {
  parseHtml,
  collectImageSources,
  collectCssUrls,
  textLayerName,
  MAX_CREATED_NODES,
} from './parse.ts'

// styles
export {
  normalizeStyles,
  clearedFamilyKeys,
  resolveStyleImages,
  IMAGE_PROPERTIES,
} from './css/normalize.ts'
export { partitionStyles, canonicalStyles } from './css/partition.ts'
export { INHERITED_TEXT_PROPERTIES, KNOWN_CSS_PROPERTIES } from './css/known.ts'
export { parseCssColor, colorsEqual } from './css/color.ts'
export { rewriteTokenRefs, tokensHash, tokensToCss, wildcardMatch } from './tokens.ts'

// apply (Loro; never commits)
export { applyHtml, HtmlApplyError } from './apply.ts'

// export
export { toJsx } from './jsx.ts'
export { renderStage } from './stage.ts'
