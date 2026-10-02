# Phase 2 — design workstream notes and requests

Reference PNGs are in `design/reference/`, listed in `design/screens.json`.

## Request 1 — two new derived tokens (owner: dark-theme / `packages/ui`)

The dark artboards need two derived tokens that do not exist yet. Their light values equal what
the light UI renders today, so adding them changes nothing in light mode:

| Token                    | Light     | Dark      | Used by                                                                                                                                                                                                                               |
| ------------------------ | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-segment-active` | `#ffffff` | `#363636` | Segmented active pill (Design/Theme, grid/list toggle), inspector fill-type and flex-direction tabs, active tool in the tool rail. They use `--color-background` today, which in dark would make the "on" pill darker than its track. |
| `--color-thumb`          | `#ffffff` | `#d9d9d9` | Slider thumb (`Slider.module.css` hard-codes `#ffffff`, which the "no literal colours" rule forbids anyway).                                                                                                                          |

All other dark values (core + derived + shadows) are in `design/tokens.dark.css`, including a table
of which literal colours in the light artboards map to which token.

## Notes for implementers (no contract change)

- **18 / 19**: Google/GitHub buttons and the "or with email" divider are removed; the form keeps
  its 24 px rhythm and re-centres vertically. `screens.spec.ts` compares against the re-exported
  PNGs, so it differs until shell-ui removes the buttons from the app.
- **22 Forgot password**: key icon tile (same 48 px tile as 20), email field (focused), primary
  "Send reset code →", centred "← Back to sign in".
- **23 Reset password**: lock icon tile, "Reset code" label + the 6-cell code input from 20 (all
  filled, no focus), "New password" field with the strength meter from 19 (focused), primary
  "Reset password →", row "Didn't get a code? Resend in 0:24 · Back to sign in", tip "Resetting
  your password signs you out of Baren on your other devices."
- **24 Image fill**: selected rect `Hero image` (1280 × 640, radius 12) on artboard
  "Landing — Desktop" at 55 %. Layers row uses the lucide `image` icon in `--color-selection`
  when selected. Fill section: fill-type tabs with the image tab active, 120 px preview
  (`--color-input` well, 5 px radius), meta row (file name / natural size), fit select
  (options Fill / Fit / Crop / Tile → `cover` / `contain` / px size / `repeat`, per contract) +
  opacity field (84 px), then "Replace" (flex 1) and "Remove" (84 px) secondary buttons.
- **25 Update ready**: toast anchored bottom-left of the content area (`left: 256px` =
  sidebar/left-panel width + 16, `bottom: 16px`, width 340, radius 10, `--shadow-popover`).
  Icon disc 28 px (`--color-selection-subtle` fill, `--color-selection` download glyph),
  title "Version 0.2.0 is ready", body "Restart to update. Your files are saved.", buttons
  Restart (primary, 28 px) and Later (ghost). The Help menu title gets a 6 px
  `--color-selection` dot (absolute, top-right of the label) while an update is ready; suggested
  menu item copy: "Restart to Update (0.2.0)…" in place of "Check for Updates…" (not drawn).
- **26–28 Emails** (600 wide, heights 588 / 612 / 710): outer `#F7F7F7`, 40/32 px padding;
  white card, 1 px `#E5E5E5`, radius 12, 40 px padding; H1 24/30 600; body 15/24 `#4D4D4D`;
  small 13/20 `#666666`; footer 12/18 `#8A8A8A` + `#ABABAB`. Code block `#F3F3F3`, radius 8,
  code 34/40 mono 600, letter-spacing 0.14em. Invite CTA `#141414`, 44 px high, 24 px side
  padding, radius 8; link fallback 12/18 mono `#2F80FF` underlined. Font stacks are noted in
  layer names: sans `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
Arial, sans-serif`; mono `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas,
monospace`. Emails are always light (literal colours, no CSS variables).
- **D01 / D06 / D18**: chrome only. File thumbnails, canvas artboards and the auth showcase
  boards are pixel-identical to light mode (thumbnail wells and the canvas use
  `--color-canvas`, so dark document content sits on a dark ground — intended).
  The "Pro" badge is omitted in 25 and D01 (no billing).
