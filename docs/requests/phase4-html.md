# Phase 4 — html workstream notes and requests

`@baren/html` (`packages/html`) implements contract §7, §8 and §12: the write_html parser
(parse5) and style normaliser, the applier (Loro, inside the caller's `transact`), `toJsx`
(inline styles and Tailwind v4), `renderStage`, the token helpers and colour/glob matching.
Every §12 export exists with the contract's signature; `apps/desktop` typechecks against it
(main's no-DOM config and the renderer config), and the runtime's `HtmlApi` compile-time check
accepts it.

## Additions to the §12 API (backwards compatible)

| Export                                                                                                              | Why                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@baren/html/sources` (package subpath)                                                                             | `collectImageSources` and `collectCssUrls` with **parse5 only** in the import graph (no `@baren/schema`, no `loro-crdt`). A test enforces it.                    |
| `NormalizeContext.image?` (optional `normalizeStyles` ctx field)                                                    | Resolve image `url()`s at normalise time (update_styles / create_artboard). Without it, image urls are kept for `applyHtml` / `resolveStyleImages`.              |
| `resolveStyleImages(patch, image, path?)`, `IMAGE_PROPERTIES`                                                       | Rewrite or drop the image `url()`s of a patch (what `applyHtml` does per node).                                                                                  |
| `JsxOptions.topLevel?`                                                                                              | Say explicitly that the root is an artboard (left/top/position dropped). Default: detected (root has `left`/`top`, no `position`, its parent is not in `nodes`). |
| `textLayerName`, `MAX_CREATED_NODES`, types `ParseOptions`, `NormalizeContext`, `ImageLookup`, `HtmlApplyErrorCode` | Shared constants/types for the runtime.                                                                                                                          |

## Request to server (owner of `src/main/mcp/controller.ts`)

`controller.ts` loads `import('@baren/html')` for the source collectors. Please import
**`@baren/html/sources`** instead: the package index pulls in `@baren/schema`, which main's
bundler aliases to `loro-crdt/web`, so the lazy MCP chunk would carry Loro's web glue (and its
WASM) for two pure string functions. Same functions, same signatures.

## How to call it (runtime notes)

- `applyHtml` returns `ApplyResult.warnings` **including** the parse warnings (deduplicated by
  code + property + path). Do not append `parsed.warnings` again.
- `applyHtml` throws `HtmlApplyError` with `node_not_found`, `invalid_target`,
  `instance_content`, `cycle`, `too_large` — always **before** the first mutation (targets,
  clone payloads, cycle check and the 5,000-node limit including clone sizes are checked
  first). `replace` with HTML that creates nothing (e.g. only `<script>`, or only unknown
  clones) is refused with `invalid_target` instead of deleting the target.
- update_styles: `normalizeStyles(styles, { tokens })` → `partitionStyles` →
  `clearedFamilyKeys(apply, node.styles)` → `setStyles`. `clearedFamilyKeys` returns the
  **full** patch (your entries plus the clearing), so `{ ...clearedFamilyKeys(p, s), ...p }`
  and `clearedFamilyKeys(p, s)` are equivalent. Image `url()`s: either rewrite them first (as
  `agent/images.ts` does) or pass `ctx.image`. Independently, the normaliser drops `url()`s in
  non-image properties, malformed `url(` tokens and script urls (`unsafe-value`).
- `renderStage(…).html` is one `<div data-baren-stage data-root-id="…">` wrapping the
  exporter's HTML (with `data-node-id`s). Its CSS declares the file's tokens on `:host` (the
  exporter's `:root` block does not apply inside a shadow root — so `tokens` are not passed to
  `renderSubtreeHtml`), the canvas base rules, the canvas's inherited defaults (Inter
  13/16 px, `#1A1A1A`), then `inherited` and `background` on the wrapper, and the upright,
  sized root. Measure the wrapper (`width/height: max-content`). Give the shadow host
  `data-design-content` so documents that use the app's light tokens without defining them
  render as on the canvas.
- `toJsx` throws a plain `Error` for a page root or a root missing from `nodes` (map to
  `invalid_target`).

## Deviations from the contract text (each with its reason)

1. **Flex and grid containers with element children are frames**, even when every child is a
   phrasing element (`<nav style="display:flex; gap:28px"><a>…</a><a>…</a></nav>`). In CSS
   those children are separate flex items, so one text layer ("Product Pricing Docs") would
   lose the gap and the per-item styles. Text-only elements without element children (e.g. a
   `display: flex` button label) are still text layers.
2. **Shorthand families are stored in one canonical form derived from the side values**
   (contract table rows hold for distinct values): `padding: 8px 8px` → `padding: 8px`,
   `padding: 1px 2px 1px 2px` → `paddingBlock` + `paddingInline`. Same rendering; normalising
   twice gives the same result.
3. **`clearedFamilyKeys` keeps the other sides**: setting `paddingTop` on a node that stores
   `padding: 10px` writes `paddingTop` + `paddingInline: 10px` + `paddingBottom: 10px` and
   removes `padding` (only removing the shorthand would drop the other three sides). Same for
   borders, radius, gap, overflow, flex, outline and single-layer backgrounds; multi-layer
   `background` values are opaque and are removed when a background longhand is set (the
   contract rule).
4. **`/>` on non-void elements is honoured**: `<x-baren-clone … />` and `<div style="…" />`
   no longer swallow the following siblings (HTML would nest them inside).
5. **Containing blocks**: a created frame with absolutely positioned children gets
   `position: relative` (unless it sets a position), and so does an unpositioned,
   non-top-level target frame receiving absolute roots — the canvas model of Phase 3 §2.4.
6. **Replacing an artboard**: the first root takes the replaced artboard's `left`/`top`
   (contract) and, when it sets none, its `width`/`height` (with `artboard-size-defaulted`),
   instead of 1440 px × fit-content.
7. **Tailwind spacing scale**: multiples of 4 px map to the default scale only up to step 96
   (384 px); beyond, arbitrary values (`w-[1440px]`, not `w-360`). Line heights use `--leading-*`
   and `--spacing-*` tokens only (`leading-6` for 24 px with `--spacing-6`, but
   `leading-[40px]`).
8. **Tailwind text layers** do not print the canonical `whitespace-pre-wrap` unless it is
   stored. Inline styles keep canonical styles (contract).
9. **Code block JSX** (`tests/jsx.test.ts`, "get_jsx of a code block"): the code line prints
   `pl-[0.14em]` before the typography classes (the fixed category order, not the stored-key
   order). Ambiguous literal colours become arbitrary properties (`[color:#FFFFFF]`).
10. Placeholder text of `<input placeholder>` gets `opacity: '0.5'` (a string, like CSS-written
    values), `<hr>` takes its thickness from `border-top-width` when it has one, and form
    controls / `<hr>` are named "Frame" (the frame rule).

## Performance (Node, vitest, this machine under load: load average 5–8)

`packages/html/tests/perf.test.ts`; budgets are asserted on the best of 9 runs (other test
files run in parallel workers), medians reported.

| What                                                                                         | Median / best                        | Budget         |
| -------------------------------------------------------------------------------------------- | ------------------------------------ | -------------- |
| `parseHtml`, 2,001 layers (2,641 elements), realistic agent HTML (styles repeat across rows) | 16–17 / 14 ms                        | ≤ 50 ms        |
| `parseHtml`, 2,001 layers, every style attribute unique                                      | 33–36 / 30 ms                        | ≤ 50 ms        |
| `applyHtml`, the same 2,001 layers in one transaction                                        | 150–162 ms                           | ≤ 1.25 × floor |
| the same nodes with plain `createNode` (the Loro floor), interleaved                         | 140–163 ms (apply / floor 0.99–1.08) | —              |
| `toJsx` of the 2,001-layer result, inline-styles / tailwind                                  | 13 / 14–15 ms                        | ≤ 50 ms        |

A full 2,000-element write_html therefore does **not** fit in 50 ms end to end in Node: Loro's
WASM map writes cost ~5 µs each (type, name, every style, text), so creating 2,000 nodes costs
80–160 ms here before any of this package's work, and the applier adds ≤ 8 % on top. Parsing
and normalising (this package's own work) stays under 50 ms. The contract's renderer budget for
a 15-line write_html (≤ 50 ms) is far from this.

## Resolution (integration, 2026-10-02)

- server: `controller.ts` imports `@baren/html/sources` (274 kB chunk, no Loro).
- Deviations 1–10 and the §12 additions are recorded in `docs/phase4/contract.md` §17.3, with
  pointers from §7.3, §7.6, §8.1 and §12.
- Integration changed `renderStage`'s canvas defaults to `line-height: normal`, matching the
  canvas's document scope (§17.6 item 1); no golden file changed.
