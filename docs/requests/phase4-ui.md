# Phase 4 — ui workstream notes and requests

ui workstream, 2026-10-02. Scope per `docs/phase4/contract.md` §1 ("ui"), §10.1, §10.4, §10.8 and
§14.4. Nothing outside the ui-owned files was edited, apart from the two canvas test files listed
under "Canvas tests" below.

## What landed

- **First change (§0 sequencing):** `RemotePresence.kind?: 'user' | 'agent'` and `badge?: string`,
  `OverlayTheme.agent`, `agentRing`, `agentGlow` in `packages/canvas/src/types.ts`.
- **Tokens (design request 1):** `--color-agent`, `--color-agent-ring` and `--color-agent-glow` in
  `packages/ui/src/styles/tokens.css` (light in section 2; dark in section 3, in both the
  `data-theme` block and the `prefers-color-scheme` copy), and `--color-overlay-agent:
var(--color-agent)` in section 5. `tokens.test.ts` lists `--color-overlay-agent` with the other
  canvas-chrome tokens.
- **Switch (design request 3):** `packages/ui` `Switch` (`role="switch"`, `aria-checked`, 28 × 16,
  140 ms knob, `--shadow-focus` ring, no animation under reduced motion).
- **Avatar (design request 4):** `variant: 'agent' | 'idle'` (22 px rounded square, `--radius-md`,
  sparkle glyph) and `presence` (8 px `--color-success` dot, 2 px `--color-background` ring).
- **Icons:** `SparkleIcon` (+ `SPARKLE_PATH`), `ServerIcon`, `LayersIcon`, `PenLineIcon`,
  `Undo2Icon` (paths from artboard 34).
- **Canvas overlay (design request 2, §10.4):** `agentWork()` and `agentBadgeText()` in
  `overlay/model.ts`; ring, glow, sweep and badge in `overlay/overlay.ts`; the ≤ 30 fps redraw
  timer in `controller.ts` (the only controller change). Agent entries never draw a cursor or a
  selection outline.
- **App:** `app/McpConnectDialog.tsx` (+ css; lazy chunk opened by `openDialog({ kind: 'mcp' })`),
  `state/mcp.ts` (status subscription and the derived texts), the MCP section states and the
  inspector agent avatars, the home "Using agents" card states, the Preferences "MCP server" row,
  `state/files.ts` reloading on `files.onChanged`. `editor/chrome/McpDialog.tsx` is deleted and
  `EditorLayout` no longer renders it.

## Decisions (where the contract left a choice)

1. **Visual tests freeze the sweep instead of emulating reduced motion.** §10.8 allows either a
   test-only sweep phase or masking the ring. Reduced motion would draw the static 1.5 px
   full-colour ring, which is not what 35/D35 show. The overlay therefore reads a test-only global,
   `globalThis.__barenAgentSweepPhase` (a number in [0, 1); **0 = the head on the artboard's
   top-right corner**, increasing clockwise). Set it before the page loads (Playwright
   `addInitScript`). A frozen sweep does not animate (`Overlay.animating` stays false). Production
   code never sets it.
2. **Sweep shape.** It is measured from the reference: the brightness is linear along the ring's
   perimeter. It fades out over 12.5 % of the perimeter behind the head (≈ 260 px along the top
   of the 600 px pricing board) and over 8.5 % ahead of it (≈ 180 px down the right edge). The
   phase origin is the top-right corner, so phase 0 reproduces the frozen frame of 35.
3. **Narrow artboards.** When the board on screen is narrower than the full badge, the badge
   becomes an 18 × 18 sparkle-only chip, still right-aligned. Ring, glow and badge are
   screen-space sizes at every zoom, as §10.4 requires.
4. **"Agent settings" in the MCP section is an outline button,** as drawn in 35 (white with a
   border, like "Connect your agent"). The contract text said "secondary". On the home card it is
   the card's secondary (muted) button, as drawn in 36.
5. **Footer error line:** "Couldn't start the MCP server: <reason>". It is ellipsized, with the
   full text as the tooltip. The MCP section's "Error" label carries the reason as its `title`.
6. **Before the first status arrives** (and in state `starting`), the MCP section shows "Not
   connected" and the dialog shows "Starting the MCP server…".
7. **With no live setup** (server off, starting or failed), the dialog shows the snippets with the
   address and a dotted placeholder token. They are built with `main/mcp/setup.ts`'s pure
   `buildSetup`, the same code the mock uses. Copy, Reveal and Regenerate are disabled until the
   server runs.
8. **"Other" segment:** the generic HTTP JSON. Below it are the line "Only supports stdio? Use the
   baren stdio shim instead." and a second code block with `stdioJson`, which has its own Copy
   button. The dialog scrolls if the window is short.
9. **MCP section rows:** the working artboards of a connected agent are the union of main's
   `McpAgentInfo.files[fileId].working` and the local `EditorState.agents` entry with the same
   `presenceId`. The first one that still exists in the document names the "Editing …" line.
10. **Inspector header:** at most 4 people, then at most 3 agents, then one muted "+N" avatar
    covering both overflows. Tooltips are "Claude Code (agent)" or "Claude Code (<via>'s agent)".
11. **Not built** (not specified by the contract or the artboards): agent badges in the layers
    panel, and toasts for agent errors. The only ui toasts are for clipboard failures, setEnabled /
    resetToken failures, and "Token regenerated…".

## Canvas tests

For the contract's canvas tests (§14.4), I added `tests/unit/agentOverlay.test.ts` and
`tests/e2e/agents.spec.ts`. I also extended two existing canvas test files: `tests/perf.spec.ts`
gets the "agent working edge" budget test, and `bench/overlay.ts` (the overlay bench page only
that spec loads) gets `agentRedraw()`. These are test-only files of `packages/canvas`.

## Requests

### runtime

- `EditorState.mcpOpen` could be removed (§11.6 item 4): `McpSection` opens the app-level dialog
  with `openDialog({ kind: 'mcp' })` and `editor/chrome/McpDialog.tsx` is deleted.
- Done by runtime meanwhile (`EditorState.agents` added, `mcpOpen` removed). The ui now reads `s.agents`
  directly, and 35/D35 plus the presence behaviour test pass against the runtime's hooks.
- Optional: a headless host's canvas does not need agent presence. While a working set is on
  its (hidden) canvas, the overlay redraws at ≤ 30 fps. Hidden windows are usually throttled,
  but skipping `setRemotePresence` for agents in headless sessions would save that work.

### server

- The renderer subscribes to `mcp:status` on its first home or editor render. `mcp:status` and
  `mcp:set-enabled` should answer from the first frame, including when the server is off or
  still loading (`state: 'off' | 'starting'`). If the invoke rejects, the UI keeps the server
  as unknown ("Not connected", Switch disabled) until the first `mcp:status` push.

### design

- The agent tokens are in `packages/ui`. Please mirror the dark values into
  `design/tokens.dark.css`: `--color-agent: #ec5a9c`, `--color-agent-ring: #ec5a9c59`,
  `--color-agent-glow: #ec5a9c33`. `tokens.test.ts` compares design → ui, so it passes before
  and after.
- Artboards 34/D34 still show the placeholder snippet (port 29980, no `--scope user`). This is
  the contract §10.7 follow-up. Today it costs about 0.2 % of pixels in the 34/D34 comparisons.

### editor (no owner this phase)

- `editor/Editor.module.css` `.backdrop`, `.dialog`, `.dialogTitle`, `.dialogBody`, `.dialogCode`
  and `.dialogActions` were only used by the deleted `McpDialog`. They can be removed when the
  file next has an owner.

## Resolution (integration, 2026-10-02)

- runtime: done (`EditorState.agents`, `mcpOpen` removed); the optional request is done too:
  headless canvases get no agent presence.
- server: `mcp:status` answers from the first frame (`off` / `starting`).
- design: the dark agent tokens are mirrored in `design/tokens.dark.css` (section 5). Redrawing
  34/D34's snippet needs the design workstream; it stays a known issue.
- editor: the unused `.backdrop` / `.dialog*` rules are removed from `editor/Editor.module.css`.
- Decisions 1–11 are recorded in `docs/phase4/contract.md` §17.4.
