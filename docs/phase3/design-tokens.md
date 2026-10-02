# Phase 3 — design tokens and notes for the editor and canvas

Design workstream, 2026-10-02. The new artboards' PNGs are in `design/reference/`, listed in
`design/screens.json`.

| #   | Artboard                           | PNG                                        |
| --- | ---------------------------------- | ------------------------------------------ |
| 29  | 29 Editor — Rotation & groups      | `reference/29-editor-rotation-groups.png`  |
| 30  | 30 Editor — Pen tool               | `reference/30-editor-pen-tool.png`         |
| 31  | 31 Editor — Components             | `reference/31-editor-components.png`       |
| 32  | 32 Editor — Component picker       | `reference/32-editor-component-picker.png` |
| 33  | 33 Editor — Drop into frame        | `reference/33-editor-drop-into-frame.png`  |
| 15  | 15 Editor — Context menu (redrawn) | `reference/15-editor-context-menu.png`     |

The artboards use literal hex values where no token exists (as in Phase 2); the table in
"Literal values → tokens" maps every new literal to a token.

## 1. New derived tokens (for `packages/ui/src/styles/tokens.css`, additive)

The component accent is a violet that sits next to `--color-selection` at the same visual weight
(similar luminance, same saturation family) without being mistaken for it, and keeps AA contrast
for 11 px labels on the panels.

| Token                      | Light     | Dark      | Used for                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-component`        | `#7b4dff` | `#9b7dff` | Component accent: main-component labels on the canvas (icon + name), the filled four-diamond (main) and outlined diamond (instance) icons in Layers / Components / picker / inspector, the override dots, the instance-of well icon. Also the colour of the canvas selection when the selection is a main component or an instance (via the overlay token below). |
| `--color-component-faint`  | `#f6f3ff` | `#2c2936` | Row tint in the Components section for the main component of the current selection (31). Light = accent at 7 % over white; dark = accent at 10 % over `--color-surface` (same rule as `--color-selection-faint`).                                                                                                                                                 |
| `--color-component-subtle` | `#eee8ff` | `#39334d` | Optional (not drawn): row tint when the main component itself is selected in the Components section. 13 % / 20 % (same rule as `--color-selection-subtle`). Add only if used.                                                                                                                                                                                     |

Canvas chrome (section 5 of `tokens.css`, `:root` only, read by the Canvas 2D overlay like the
other `--color-overlay-*` tokens):

| Token                       | Value                    | Used for                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-overlay-component` | `var(--color-component)` | Main-component label (11 px filled four-diamond + name, 11 px / 500) in place of the grey artboard label; selection outline, handle borders and size pill when the selection is a main component or an instance (31); the 1 px "related" outline (offset 2 px) around the main of a selected instance (31, optional). |

Contrast (WCAG): `#7b4dff` is 4.83:1 on `#ffffff`, 4.51:1 on `--color-surface` `#f7f7f7`, 4.16:1
on the canvas `#eeeeee`, 4.41:1 on `#f6f3ff`; white text on it 4.83:1 (size pill). Dark `#9b7dff`
is 5.61:1 on `#1a1a1a`, 5.25:1 on `#202020`, 5.94:1 on the dark canvas `#141414`; white text on
it 3.1:1, the same order as the existing dark selection pill (white on `#3b8cff`, 3.29:1).

`packages/ui/src/styles/tokens.test.ts` requires a dark value for every new colour token (both
are given above) and requires `design/tokens.dark.css` to match `packages/ui` exactly, so the
design files are **not** changed yet: once the editor has added the tokens, the two dark values
can be copied into section 3 of `design/tokens.dark.css`.

### Existing tokens reused (no change)

- Selection, handles, size pills, angle label: `--color-overlay-selection`,
  `--color-overlay-handle`, `--color-on-accent`, `--radius-sm` (pill), 6 px handles.
- Drop target tint: `--color-overlay-marquee` (the existing drop overlay; artboard literal
  `#2F80FF14`).
- Layer rows: `--color-selection-strong` (`#DCE9FF`, selected row), `--color-selection-faint`
  (`#F2F6FF`, rows inside the selected node's parent), as in 14 and 24.
- Active tool in the rail (pen in 30, component in 32): `--color-segment-active` +
  `--shadow-tool-active`.
- Component picker: `--color-background`, `--radius-menu` (10 px), `--shadow-popover`,
  `--color-input` (search field), `--color-muted` (hovered tile), `--color-border` (tile ring).

### Literal values → tokens

| Literal in 29–33                                                                          | Token                                                 |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `#7B4DFF`                                                                                 | `--color-component` / `--color-overlay-component`     |
| `#F6F3FF`                                                                                 | `--color-component-faint`                             |
| `#2F80FF14`                                                                               | `--color-overlay-marquee`                             |
| `#DCE9FF`, `#F2F6FF`                                                                      | `--color-selection-strong`, `--color-selection-faint` |
| picker shadow `#00000014 0 0 0 1px, #0000002E 0 12px 32px -8px, #00000014 0 4px 8px -4px` | `--shadow-popover`                                    |
| cursor glyphs (black + white halo)                                                        | not tokens: cursor assets                             |
| content colours (`#14213D`, `#FFC857`, `#1F7A50`, `#EEF2F8`, …)                           | design content (document data), never tokens          |

## 2. Per-artboard notes

### 29 Editor — Rotation & groups

- A rect inside a group, rotated 15° by its corner zone. The selection box (1.5 px outline) and
  its four 6 px handles **rotate with the node**; the size pill is hidden while rotating.
- Rotate cursor: 24 px glyph, a quarter arc with an arrowhead at each end, black 2 px with a
  5 px white halo, drawn so the arc wraps the corner it is hovering (rotate it by the corner,
  0/90/180/270°, plus the selection's rotation). Hotspot = the arc's centre, about 10 px outside
  the corner along the diagonal. Zone: outside each corner, up to 16 screen px (contract).
- Live angle label = the size pill style (18 px, radius 4, 11 px / 500 white on the selection
  colour), ≈ 20 px right of the pointer and ≈ 10 px below it, text `15°`.
- Layers: the group row uses lucide **`SquareDashed`** (13 px, `--color-foreground-muted`; the
  contract's "dashed-corner square"), expandable like a frame; the rect uses lucide `Square`
  (selection colour when selected). Rows inside the entered group get `--color-selection-faint`.
- Inspector Layout shows the rotation in the existing angle field (`15°`); W/H are the
  unrotated box. A dashed outline for the entered group's bounds was tried and removed (not in
  the canvas contract).

### 30 Editor — Pen tool

- Vector edit mode on a closed path: 1 px path outline in the selection colour; anchors are
  **6 px squares** (white fill, 1 px selection border), the selected anchor is filled with the
  selection colour; handles are **5 px circles** (white, 1 px border) joined to their anchor by a
  1 px line — shown for selected anchors and their neighbours (contract §5.2).
- Pen tool active in the rail. Hovering a segment shows the pen cursor with a "+" (insert point).
- Inspector for a vector: Layout, Fill, **Stroke**, Blending, Shadow, Filters. Stroke rows:
  paint (swatch, hex, opacity, eye, minus); weight (three-lines icon) + dash select (`Solid`);
  **Cap** Butt / Round / Square and **Join** Miter / Round / Bevel as 3-option segmented
  controls (label column 40 px, 11 px muted). Cap icons show a thick bar ending at a 1.5 px
  selection-colour guide line (the path end); join icons are a thick corner drawn with each
  `stroke-linejoin`. The active option uses the white segment pill like the fill-type tabs.
- Vector layer icon = the existing spline icon (two end circles + curve) from 14's
  "Icon / mail" row.
- An "Editing Peak · Done ↵" bar and a "Point" section (X/Y + corner/smooth toggle) were explored
  and removed: not in the contract (Escape/Enter/click outside exit; double-click an anchor
  toggles corner/smooth).

### 31 Editor — Components

- **Left panel: a collapsible "Components" section in the Design view, between Pages and
  Layers** (same header pattern as Pages: chevron, title 13/500, search icon on the right; rows
  28 px, indent 22, 13 px filled four-diamond in `--color-component`, name 13 px, instance count
  11 px `--color-foreground-subtle` right-aligned). Why not a third segment in the Design/Theme
  toggle: the toggle switches between the document's structure and its token table; components
  are document structure (mains are layers on pages, instances are layers), and you need the
  layer tree visible at the same time to drag an instance into a frame or to jump to a main. A
  third segment would also squeeze the 219 px toggle (three 71 px segments). This matches
  contract §6 ("Components panel … between Pages and Layers").
- When the Components section is shown, the layer tree gets a **"Layers" header row** (same as
  the Pages header, no action) so the two lists do not run together. Files without components
  keep the Phase 2 layout (06/14/24 unchanged).
- The Components row of the selection's main gets `--color-component-faint`.
- Layer icons: main = filled four-diamond (lucide `Component`, filled), instance = outlined
  diamond (lucide `Diamond`), both 13 px in `--color-component`; names stay
  `--color-foreground`. Selected rows keep the blue selection tints.
- Canvas: top-level mains carry their label in the component colour (11 px icon + name) instead
  of the grey artboard label. The selected instance (here a nested instance inside the "Team"
  instance of `Card / Plan`) is outlined, handled and labelled (`Fill × 44`) in the component
  colour; its main gets a 1 px component-colour outline offset 2 px (related highlight,
  optional).
- Inspector **Component** section at the top: header "Component" + right "Instance" (11 px
  subtle; "Main component" for mains); a 26 px well with the instance diamond, the component name
  (11 px / 500) and a chevron; an overrides row: 6 px component-colour dot, "2 overrides"
  (11 px), the overridden kinds "Text, Fill" (11 px subtle) and on the right "Reset overrides"
  (rotate-ccw icon + 11 px / 500 muted); an actions row with the 24-style secondary buttons
  "Go to main component" (flex 1, target icon) and "Detach" (76 px, unlink icon). Overridden
  sections get a 6 px component-colour dot after their title ("Fill ●").

### 32 Editor — Component picker

- The rail's component tool is active; its popover opens 8 px right of the rail, top aligned
  with the button (canvas y = button top − 7). Width 288, `--radius-menu`, `--shadow-popover`.
- Search field (30 px, `--color-input`, radius 6, search icon 13 px, placeholder 13 px subtle),
  section label "In this file" + count (11 px), then a 2-column grid of tiles (132 px, gap 8,
  padding 8): tile padding 4, radius 8; preview 72 px, white (design content) with a 1 px
  `--color-border` ring, radius 5, the main rendered small and centred; caption 10 px filled
  four-diamond + name 11 px. Hovered / keyboard-focused tile: `--color-muted` tile and a 1.5 px
  selection-colour ring on the preview; grab cursor. Footer 32 px with a top border: "Click to
  insert, or drag onto the canvas" (11 px muted).
- Nothing selected, so the inspector shows Page + MCP (as 04). The Components section lists the
  same six components.

### 33 Editor — Drop into frame

- The "Popular" badge (an instance) is dragged out of the Team card's header into the Starter
  card (a flex column), between its header and its price. Drop target = the existing drop
  overlay: `--color-overlay-marquee` fill over the target's box and a 2 px selection outline
  just outside it; the insertion line is 2 px, across the target's full width, at the middle of
  the gap (`flowDropIndex`). The dragged layer is drawn at the pointer offset with the 1.5 px
  selection outline and its size pill (`Hug × 24`), no handles; the original is hidden with
  `visibility` (its space stays). No labels.
- Ctrl (⌘) keeps the current parent (contract). An on-canvas hint ("Move into Features · Hold
  Ctrl to keep it in Starter") and a "→ Features" pointer label were explored and removed to stay
  within the contract; worth revisiting if users miss the modifier.

### 15 Editor — Context menu (redrawn)

Three always-visible items added (contract §6): **Paste in place** `Ctrl+Shift+V` after "Paste
here", **Group selection** `Ctrl+G` and **Create component** `Ctrl+Alt+K` after "Wrap in
frame". The menu grows by 90 px (now 495 px high at the same origin); the "Copy as" submenu and
the cursor move down 30 px with their row. Conditional items (Ungroup, Go to main component,
Reset overrides, Detach instance) do not apply to the 15 fixture selection and are not drawn;
they use the same row style and shortcuts from the contract (`Ctrl+Shift+G`, `Ctrl+Alt+B`).
