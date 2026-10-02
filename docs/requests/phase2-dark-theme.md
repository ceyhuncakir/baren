# Phase 2 — dark-theme notes and requests

dark-theme owns `packages/ui/**`, every stylesheet under `apps/desktop/src/renderer/**`, the
canvas chrome colours in `packages/canvas` and `apps/desktop/tests/visual/dark.spec.ts`.
Nothing here edits ARCHITECTURE.md.

## What was built (for the contract / STATUS)

- **Tokens** (`packages/ui/src/styles/tokens.css`): light set on `:root`, dark set on
  `:root[data-theme="dark"]` (`color-scheme: dark`), values from `design/tokens.dark.css`
  (core values as in the contract). New derived tokens, each with a light value equal to what
  light mode rendered before (light screens are pixel-identical to before):
  `--color-segment-active`, `--color-thumb` (design request), `--color-on-accent`,
  `--color-glyph-muted`, `--color-primary-active`, `--color-muted-active`,
  `--color-input-hover`, `--color-destructive-active`, `--color-destructive-strong`,
  `--color-checker(-alt)`, `--color-handle`, `--color-scrollbar(-hover)`,
  `--color-scrim(-subtle)`, `--shadow-toast`, `--shadow-thumb-hover`, `--shadow-swatch`,
  `--shadow-swatch-base`, `--shadow-well`, `--shadow-identity`, `--shadow-handle(-subtle)`.
- **First paint**: the same dark set is also applied by
  `@media (prefers-color-scheme: dark) { :root:not([data-theme]) }`. The main process sets
  `nativeTheme.themeSource` from the preference, so in Electron this is already the app theme
  before `installTheme()` sets `data-theme` (belt and braces for "no flash"; checked equal to
  the dark block by `tokens.test.ts`).
- **Document scope** (the "reset app tokens on the content root" rule): the light token block
  is declared on `:root, .ic-root, [data-design-content]`, and `.ic-root, [data-design-content]`
  also get `color-scheme: light; color: #1a1a1a`. The canvas sets the document's own tokens
  inline on `.ic-root`, so they win; tokens a document does not define resolve to the
  default light values; untyped text is `#1A1A1A`. `[data-design-content]` is the hook for any other
  element that renders design content (the off-screen thumbnail/PNG renderer uses it).
- **Canvas chrome tokens** (declared on `:root` only, so the document scope inherits the app's
  resolved values instead of resetting them): `--color-canvas-ground`,
  `--color-overlay-selection | -label | -label-active | -handle | -snap | -marquee`.
  - `@baren/canvas` draws the page ground as `var(--color-canvas-ground, #EEEEEE)` when the
    page has the default background (`DEFAULT_PAGE_BACKGROUND`, `#EEEEEE`); any other page
    background is document data and is drawn as is.
  - The Canvas 2D overlay reads the `--color-overlay-*` properties from the canvas container
    (explicit `theme` options still win; hosts without the tokens get `DEFAULT_THEME`) and
    re-reads them when `<html>`'s `data-theme`/`class` changes, repainting immediately. Size-pill
    text, handles and remote-cursor strokes stay white (on the selection/collaborator colour).
- **Button variant** `raised` (21 "Open browser again"); `oauth` is kept as a deprecated alias.
  `GoogleIcon` / `GitHubIcon` and the playground's "Continue with Google/GitHub" specimens are
  removed (accounts are email + password only).
- **Playground**: `?theme=dark` and a "Toggle light / dark" nav item.

## Edits outside the strict ownership (minimal, colour-related)

- `packages/canvas/src/controller.ts` `applyPageBackground` (the hard-coded `'#EEEEEE'` ground)
  and `packages/canvas/src/overlay/overlay.ts` (overlay colours from tokens) — canvas chrome.
- `apps/desktop/src/renderer/editor/inspector/sections/AppearanceSections.tsx`: the solid
  fill-type glyph's inline `#9A9A9A` → `var(--color-glyph-muted)`.
- `apps/desktop/src/renderer/editor/session/raster.ts`: one attribute,
  `host.setAttribute('data-design-content', '')`. Without it a file thumbnail captured in dark
  inherits the dark app tokens and text colour (white text on white artboards); the dark spec
  has a test for it.

## Requests

### shell-ui (`renderer/fixtures/thumbs/*.png`)

- The design fixture's file thumbnails are crops of the light artboard 01 with its `#EEEEEE`
  page ground baked in (opaque RGB). Real thumbnails (`editor/session/raster.ts`) are the
  artboard alone on the card's `--color-canvas` well, which is what D01 draws, so in dark the
  fixture shows light wells inside dark cards. `dark.spec.ts` excludes the seven thumbnail
  images from the D01 number (1.13 %; 17.5 % with them) and checks the wells instead. Please
  replace them with RGBA thumbnails whose ground is transparent. They can be recovered exactly
  from the two references (two-background matting: for each pixel of the 247×164 box,
  `1 − α = (C₀₁ − C_D01) / (#EE − #14)`, colour `= (C₀₁ − (1 − α)·#EE) / α`); light mode stays
  identical.
- `auth/BrowserScreen.tsx`: use `variant="raised"` instead of the deprecated `"oauth"`.
- Identity colours (`lib/identity.ts` team colours, `@baren/ui` avatar palette) include
  `#1A1A1A`, which is the dark page colour. Avatars and team marks now get a light hairline in
  dark (`--shadow-identity`), so they stay visible; consider a palette without near-black.

### images / editor (`renderer/editor/**`, `packages/canvas/**`)

- `inspector/sections/PageSections.tsx` shows the page background value (`EEEEEE`), but the
  default ground now follows the app theme (`#141414` in dark). Consider labelling the default
  as "Default" (and treating a picked colour as document data, as the canvas does).
- `packages/canvas` tests do not cover the overlay's token theming (covered end to end by
  `dark.spec.ts` "switching theme at runtime …"); a canvas e2e that sets
  `--color-overlay-selection` on the container would pin it there too.
- The gradient fill-type glyph (`linear-gradient(90deg, #E8E8E8, #9A9A9A)`) is still inline;
  D06 draws it unchanged, so it was left as is.

### design

- No dark artboards exist for menus, popovers, dialogs, toasts, the update card, team screens
  or auth steps other than 18. They use the same tokens (menus/popovers on
  `--color-background` with the light hairline ring of `--shadow-menu`/`--shadow-popover`);
  worth drawing at least one dark menu and one dark dialog.
- D01's view toggle uses `--color-background` for the "on" item (on its `--color-surface`
  track), not `--color-segment-active` as the token request says; the app follows the artboard
  (only the surface-track variant differs).
- Swatches in dark: near-white document colours keep D06's `#00000026` inner hairline;
  other colours get a light `#FFFFFF26` hairline (`--shadow-swatch-base`) so near-black colours
  stay visible on dark panels. D06 does not draw a dark swatch.

### ARCHITECTURE.md (proposed additions to "Dark theme")

- Document scope: `.ic-root` and `[data-design-content]` re-declare the light token set and
  `color: #1A1A1A`; elements that render design content outside the canvas set
  `data-design-content`.
- Canvas chrome tokens (`--color-canvas-ground`, `--color-overlay-*`) live on `:root` only; the
  canvas reads them; the default page background (`#EEEEEE`) is drawn with the app's canvas
  colour, any other page background is document data.
- `tests/visual/dark.spec.ts`: D01/D06/D18 vs references, content isolation, runtime switch.
