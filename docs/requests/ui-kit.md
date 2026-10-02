# Contract notes from ui-kit

Proposals and integration notes from the ui-kit workstream (`packages/ui`). Fold into
ARCHITECTURE.md or reject at integration.

## 1. How apps consume `@baren/ui`

- **One stylesheet:** `import '@baren/ui/styles.css'` once at the renderer root. It holds
  the tokens, the bundled fonts (Inter variable with the `opsz` axis, JetBrains Mono
  400/500/600) and the base reset. Component styles are CSS Modules that come with the
  components, so Vite merges them into the app's CSS.
- **`@baren/ui/tokens.css` now contains only the `:root` variables.** Fonts moved to
  `global.css`, as the ui-kit task specifies. `apps/desktop/src/renderer/main.tsx`
  (screens) still imports `@baren/ui/tokens.css` and **must switch to
  `@baren/ui/styles.css`**. Until it does, the app falls back to `sans-serif`.
- Other subpaths: `@baren/ui/icons` (icons only), `@baren/ui/global.css`.
- The package ships TypeScript source (`exports["."] = ./src/index.ts`), like
  `@baren/schema`. Consumers need `vite/client` types for `*.module.css`. The desktop
  `tsconfig.web.json` already has them.

## 2. Global base behaviour that screens/editor should know

- `body` has `user-select: none`, `cursor: default` and `overflow: hidden`, which suits a
  desktop app. Inputs, textareas, `[contenteditable]` and `.selectable` can be selected.
  Every scrolling region must set its own `overflow: auto`.
- `text-rendering: geometricPrecision` and Inter's `opsz` axis are needed to match the reference
  designs' text widths and line wrapping. Without them, 12px card text wraps differently and the
  22px titles are about 2px too wide, as measured against `design/reference/*.png`.
- Focus ring: `:focus-visible` gets a 2px `--color-selection` outline. Components that have
  their own ring (inputs, menu items, rows) suppress it.

## 3. Tokens added beyond the design token set (section 2 of `tokens.css`)

These values appear literally in the artboards but have no design token. They are named in
the same namespaces so components never hard-code hex values:

`--color-selection-subtle #E3EEFF` (selected row), `--color-selection-strong #DCE9FF` (nested
selected layer), `--color-selection-faint #F2F6FF` (rows inside the selection's parent),
`--color-selection-halo #2F80FF26` (focus halo), `--color-destructive #C8301E`,
`--color-destructive-border #F1C7C3`, `--color-success #22A55B`,
`--color-success-strong #16833F`, `--color-warning #CA8A04`, `--color-control-border #CFCFCF`,
`--color-dot #BDBDBD`, `--color-track #E2E2E2`, plus hover tints,
`--text-3xl 28px / --leading-3xl 34px / --tracking-heading -0.025em` (auth headings),
`--radius-field 5px`, `--radius-menu 10px`, and the shadows `--shadow-menu`,
`--shadow-popover`, `--shadow-segment`, `--shadow-tool-active`, `--shadow-control`,
`--shadow-ring`, `--shadow-focus`, `--shadow-thumb`.

Proposal: either add these to the design token set or record them in ARCHITECTURE.md
as "derived tokens" owned by ui-kit.

## 4. Requests to other workstreams

- **canvas-engine:** user designs use `font-family: Inter` (and "System Sans-Serif"), but the
  bundled face registers as `"Inter Variable"`. When rendering design nodes, map `Inter` to
  `'Inter Variable'`, or register alias `@font-face` rules for `Inter` that point at the same
  files. Otherwise canvas text falls back to a system font.
  Use the same `text-rendering: geometricPrecision`.
- **editor:** the layer tree should virtualize `LayerRow` with `@tanstack/react-virtual`
  using `estimateSize: () => LAYER_ROW_HEIGHT` (28). `LayerRow` is memoized and passes the
  row `id` to every callback, so one stable handler can serve every row. Selection is
  reported on pointer-down (`onSelectRow(id, e)`, so the handler can read modifier keys).
  Drag/drop visuals come from `dragging` and `dropPosition` ('before' | 'after' | 'inside').
- **editor:** `NumberField` reports `onChange(value, { final })`. `final: false` arrives at
  most once per frame while scrubbing (preview only). Commit to Loro only on `final: true`.
  `ColorPicker` follows the same pattern with `onChange` and `onChangeEnd`.
- **screens:** the menu bar is `MenuBar` + `MenuBarMenu` (exact 09–13 geometry: menus 8px
  below the title, widths 248/248/300/200/220). Wire `MenuItem.onSelect` to
  `runCommand(...)` and `disabled` to `!useCommandEnabled(...)`. `TitleBar` sets
  `-webkit-app-region: drag`, and its menu/controls slots are `no-drag`.
  `WindowControls` takes `maximized` and the three callbacks from `bridge.window`.
- **screens:** product decision: no "Pro" badge, so `NavItem`/`MenuItem` examples omit it.
  `Badge variant="outline"` exists if a non-billing badge is ever needed.
