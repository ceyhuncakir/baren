# Phase 3 — design workstream notes and requests

New artboards 29–33; artboard 15 redrawn. PNGs are in `design/reference/`, listed in
`design/screens.json`. Full token and per-artboard notes: `docs/phase3/design-tokens.md`.

## Request 1 — component accent tokens (owner: editor, `packages/ui` tokens.css, additive)

| Token                       | Light                                         | Dark      |
| --------------------------- | --------------------------------------------- | --------- |
| `--color-component`         | `#7b4dff`                                     | `#9b7dff` |
| `--color-component-faint`   | `#f6f3ff`                                     | `#2c2936` |
| `--color-overlay-component` | `var(--color-component)` (section 5, `:root`) | follows   |

Light mode of every existing screen is unchanged (new names only). `tokens.test.ts` needs both
values for each colour token. `design/tokens.dark.css` is deliberately not changed yet (the test
requires it to equal `packages/ui`); mirror the dark values there after the tokens land.

## Request 2 — component colour on the canvas overlay (owner: canvas; SHOULD, not in the contract)

Artboard 31 draws, with `--color-overlay-component` read like the other overlay colours:

1. the label of a top-level main component (11 px filled four-diamond + name, 11 px / 500) in
   place of the grey artboard label;
2. the selection outline, handle borders and size pill when the selection is a main component,
   an instance or a virtual node inside one;
3. optionally, a 1 px outline offset 2 px around the main of a selected instance.

If the canvas keeps the blue selection for instances, the 31 visual test still fits its 3 %
budget (outline, handles and pill are a few hundred pixels), but the design intent is the violet.

## Request 3 — artboard 15 reference changed (owners: editor; integration)

`design/reference/15-editor-context-menu.png` now shows the three always-visible items of
contract §6 (Paste in place, Group selection, Create component). Per the contract's interim rule
the editor ships those items together with this reference; until both are in, the 15 visual test
compares the old menu with the new reference.

## Alignment with the Phase 3 contract (no request)

The artboards were adjusted to the contract after it appeared: vector anchors are 6 px squares
and handles 5 px circles (30); the vector inspector has no "Point" section and there is no
on-canvas "Editing … Done" bar (30); the drop target uses the existing drop overlay (2 px
outline + marquee tint), the dragged layer keeps its selection outline and size pill, and the
original is hidden (33); no reparent hint or pointer label (33); no dashed bounds for an entered
group (29). The Components panel is the collapsible section between Pages and Layers (31/32),
the component picker a popover from the rail button with search (32).
