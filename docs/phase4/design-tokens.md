# Phase 4 — design tokens and notes for the MCP server UI

Design workstream, 2026-10-02. The new artboards' PNGs are in `design/reference/`, listed in
`design/screens.json`.

| #   | Artboard                               | PNG                                           |
| --- | -------------------------------------- | --------------------------------------------- |
| 34  | 34 Editor — Connect your agent         | `reference/34-editor-connect-agent.png`       |
| 35  | 35 Editor — Agent working              | `reference/35-editor-agent-working.png`       |
| 36  | 36 Home — Agents connected             | `reference/36-home-agents-connected.png`      |
| D34 | D34 Editor — Connect your agent (dark) | `reference/D34-editor-connect-agent-dark.png` |
| D35 | D35 Editor — Agent working (dark)      | `reference/D35-editor-agent-working-dark.png` |

Bases: 34 is 05 (canvas overview, nothing selected) with the dialog over it. 35 is 32 (pricing
file at 100 %) with nothing selected. 36 is 01. D34 and D35 are built on D06's dark chrome. Only
chrome changes in the dark artboards: canvas content (boards, pricing artboard, component mains)
is identical to light.

The light artboards use tokens where one exists. Agent colours and dark values are literal
hex, as in Phase 2 and 3. The "Literal values → tokens" table below maps each literal to its
token.

## 1. New tokens (for `packages/ui/src/styles/tokens.css`, additive)

The agent accent is a magenta. It is the one colour on screen that means "an agent is doing
this". It sits apart from every hue already in use: selection blue `#2f80ff`, component violet
`#7b4dff`, avatar orange-red `#f04e1e`, success green, warning amber and destructive red. In
light mode it keeps AA contrast for 11 px labels on panels and on the canvas.

| Token                | Light       | Dark        | Used for                                                                                                                                             |
| -------------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-agent`      | `#d0391e`   | `#d0391e`   | The seal's vermilion: agent avatars (inspector header, MCP section, home card), the 2 px ring around an artboard an agent is editing and its island. |
| `--color-agent-ring` | `#d0391e1a` | `#d0391e26` | 4 px halo around that ring: the agent colour at 10 % (light) or 15 % (dark).                                                                         |
| `--color-agent-glow` | `#d0391e33` | `#d0391e40` | Soft glow outside the ring (`0 0 24px 2px`): the agent colour at 20 % (light) or 25 % (dark).                                                        |

Canvas chrome (section 5 of `tokens.css`, `:root` only, read by the Canvas 2D overlay like the
other `--color-overlay-*` tokens):

| Token                   | Value                | Used for                                                     |
| ----------------------- | -------------------- | ------------------------------------------------------------ |
| `--color-overlay-agent` | `var(--color-agent)` | Agent ring and island fill (halo/glow use the tokens above). |

Text and glyphs on the agent colour use the existing `--color-on-accent` (`#ffffff` in both
themes), the same rule as text on `--color-selection` and `--color-avatar`.

`packages/ui/src/styles/tokens.test.ts` requires `design/tokens.dark.css` to match `packages/ui`
exactly, so `design/tokens.dark.css` is **not** changed yet (same approach as Phase 3). Once the
UI workstream adds the three tokens, copy their dark values into a new section 5 of
`design/tokens.dark.css`.

### Contrast (WCAG)

| Pair                                           | Ratio                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `#d0391e` on `#ffffff`                         | 4.90:1                                                                                     |
| `#d0391e` on `--color-surface` `#f7f7f7`       | 4.57:1                                                                                     |
| `#d0391e` on the canvas `#eeeeee`              | 4.22:1                                                                                     |
| white text on `#d0391e` (island, both themes)  | 4.90:1                                                                                     |
| `#d0391e` on `#1a1a1a` / `#202020` / `#141414` | 3.56 / 3.33 / 3.76:1 (ring and island are graphics: ≥ 3:1; no agent-coloured text on dark) |

### Existing tokens reused (no change)

- Dialog: `--color-background`, `--radius-xl`, `--shadow-popover` (as the Share popover in 08),
  backdrop `--color-scrim-subtle` (as the current `McpDialog` `.backdrop`).
- Client switch: Segmented, the same as the Design/Theme switch (`--color-muted` track,
  `--color-segment-active` + `--shadow-segment` pill).
- Code block: `--color-input`, `--radius-md`, `--font-mono` 12/18 (as `.dialogCode`).
- Status dots (6 px): connected `--color-success`; waiting / not connected / off `--color-dot`;
  error `--color-destructive`.
- Switch (new control, see request 3 in `docs/requests/phase4-design.md`): on track
  `--color-foreground`, on knob `--color-background`; off track `--color-track`, off knob
  `--color-thumb`; knob shadow `--shadow-thumb`. This follows the checked-checkbox rule (dark
  fill, background-coloured mark), so it inverts correctly in dark.
- Idle agent avatar: `--color-muted` fill with a `--color-foreground-muted` glyph. Presence dot on an
  active agent avatar: `--color-success`, 8 px, 2 px `--color-background` ring.

### Literal values → tokens

| Literal in 34–36 / D34–D35                                                                                                                  | Token                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `#D0391E` (both themes)                                                                                                                     | `--color-agent` / `--color-overlay-agent`                          |
| `#D0391E1A` / `#D0391E26` (4 px halo)                                                                                                       | `--color-agent-ring`                                               |
| `#D0391E33` / `#D0391E40` (24 px glow)                                                                                                      | `--color-agent-glow`                                               |
| `#22A55B` / `#34C26F` (status and presence dots)                                                                                            | `--color-success`                                                  |
| `#BDBDBD` / `#5C5C5C` (status dot)                                                                                                          | `--color-dot`                                                      |
| `#0000001F` / `#00000080` (dialog backdrop)                                                                                                 | `--color-scrim-subtle`                                             |
| dialog shadow `#00000014 0 0 0 1px, #0000002E 0 12px 32px -8px, #00000014 0 4px 8px -4px`                                                   | `--shadow-popover`                                                 |
| `#FFFFFF` island text                                                                                                                       | `--color-on-accent`                                                |
| `#363636` (dark active segment)                                                                                                             | `--color-segment-active`                                           |
| knob shadow `#0000001F 0 0 0 1px, #00000026 0 1px 3px`                                                                                      | `--shadow-thumb`                                                   |
| dark chrome hexes (`#1A1A1A`, `#202020`, `#262626`, `#2A2A2A`, `#2E2E2E`, `#EDEDED`, `#A0A0A0`, `#6B6B6B`, `#F2F2F2`, `#111111`, `#9B7DFF`) | the dark values of the matching tokens in `design/tokens.dark.css` |
| pricing content colours (`#14213D`, `#1F7A50`, `#F5F7FB`, …)                                                                                | design content (document data), never tokens                       |

## 2. Per-artboard notes

### 34 Editor — Connect your agent

"Connect your agent" (MCP section, not connected) and "Agent settings" (MCP section, connected;
the home card) open the same modal dialog, centred in the window over `--color-scrim-subtle`.
It replaces today's informational `McpDialog`.

- Dialog: width 480, `--radius-xl`, `--color-background`, `--shadow-popover`. It is made of five stacked
  blocks, the last four separated by 1 px `--color-border` rules (the Share popover pattern).
- **Header** (padding 14 top, 16 left, 14 right): title "Connect your agent" 13/600; close button 24 px
  with a 14 px X in `--color-foreground-muted`. Description 12/18 muted, padding-right 32:
  "Let coding agents like Claude Code, Cursor and Codex read and edit your files live, through
  the MCP server built into baren."
- **Server row** (padding 14/16, gap 10). It uses the Share popover row pattern: a 28 px icon tile
  (`--color-muted`, radius 6, lucide `Server` 14 px in `--color-foreground`); "MCP server" 12/500; a
  sub line 11/14 muted; and the **enable/disable switch** (28 × 16) on the right.
  - On: sub line "On · Only apps on this computer can connect".
  - Off: sub line "Off · Agents can't connect"; the setup and capabilities blocks stay visible at
    50 % opacity and are not interactive; status line "MCP server is off".
- **Setup** (padding 14/16, gap 10):
  - Client switch: a Segmented control over the full width with four equal segments: **Claude Code |
    Cursor | Codex | Other**. Active = white pill, 12/500; inactive = 12/400 muted. The last choice
    is remembered per install.
  - Label 11/500 muted, then a code block (`--color-input`, radius 6, padding 10/12, right
    padding 64 so text never runs under the buttons; `--font-mono` 12/18, `white-space: pre`).
    Top-right buttons (6 px inset): **Reveal** (26 px ghost, lucide `Eye` 14 muted, becomes
    `EyeOff` while revealed) and **Copy** (26 px, `--color-background` + `--shadow-ring`,
    lucide `Copy` 14; becomes `Check` for 1.5 s after copying). Copy always copies the
    **unmasked** snippet. The token is masked as `••••••••` plus its last 4 characters until
    Reveal is pressed.
  - Token row: lock 12 px `--color-foreground-subtle` + "Includes your access token. Keep it
    private." 11 muted; on the right **"Regenerate token"** (lucide `RotateCcw` 12 + 11/500 muted,
    the "Reset overrides" pattern from 31). Regenerating disconnects connected agents. Ask before
    doing it (native confirm or an inline "Regenerate? Connected agents will need the new
    token." with Cancel / Regenerate), then update the snippet in place.
  - Snippets per segment (port and URL are placeholders until the Phase 4 contract fixes
    them; the artboard shows `http://127.0.0.1:29980/mcp`):

    | Segment     | Label                           | Snippet                                                                                                                                                                                                                                                                                            |
    | ----------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | Claude Code | Run this in your terminal       | `claude mcp add --transport http baren \`<br>`  <url> \`<br>`  --header "Authorization: Bearer <token>"`                                                                                                                                                                                           |
    | Cursor      | Add to ~/.cursor/mcp.json       | `{ "mcpServers": { "baren": { "url": "<url>", "headers": { "Authorization": "Bearer <token>" } } } }` (pretty-printed, 2-space indent)                                                                                                                                                             |
    | Codex       | Add to ~/.codex/config.toml     | `[mcp_servers.baren]`<br>`url = "<url>"`<br>`http_headers = { "Authorization" = "Bearer <token>" }`                                                                                                                                                                                                |
    | Other       | Add to your MCP client's config | `{ "mcpServers": { "baren": { "type": "http", "url": "<url>", "headers": { "Authorization": "Bearer <token>" } } } }`, plus one line under the block: "Only supports stdio? Use the baren stdio shim instead." with a copy of the shim's `command` / `args` config (name per the Phase 4 contract) |

    Cursor (`url` + `headers`) and Codex (`url` + `http_headers`) formats were checked against
    their current docs.
- **Capabilities** (padding 12/16/16, gap 8): label "What agents can do" 11/500 muted, then three
  rows: a 16 px icon slot (14 px lucide, `--color-foreground-muted`, stroke 1.75), gap 10, text
  12/16 `--color-foreground`:
  `Layers` "Read layers, styles and tokens; export JSX and screenshots" · `PenLine` "Create
  artboards and edit layers, text and styles on the canvas" · `Undo2` "Every change syncs to
  your team and undoes in one step". The last row is the undo affordance hint.
- **Footer** (`--color-surface`, bottom radius 12, padding 10 / 16 left / 12 right): the
  **connection status line** on the left (6 px dot + 12/16 muted), "Learn more" (ghost, 12/500
  muted, opens the docs) and "Done" (primary, 30 px) on the right. Status texts:
  - waiting (drawn): `--color-dot` "Waiting for an agent to connect…"
  - connected: `--color-success` "Connected · Claude Code" (name from MCP `clientInfo`; with more
    than one client: "Connected · Claude Code, Cursor")
  - off: `--color-dot` "MCP server is off"
  - error: `--color-destructive` "Couldn't start the MCP server" + the reason (for example "port 29980 is in use").
- Behind the dialog the MCP section keeps its own state ("Not connected" here).

### 35 Editor — Agent working

Claude Code is editing "Pricing — Desktop". Nothing is selected, so the inspector shows Page and MCP.

- **Island**: a 24 px tab rising from the ring's top edge, flush with its outer right edge, so
  ring and island read as one shape: `--color-overlay-agent` fill, radius 8 on top, a concave 8 px
  fillet where it meets the ring on the left. Inside: the Baren medallion (16 px, the round
  centre of the seal) 4 px from the left, gap 6, the name 12/600 `--color-on-accent`, padding
  right 10. The name comes from `clientInfo` (fallback "Agent"); two agents on one artboard share
  one island: "Claude Code & Cursor". On an artboard narrower than the island only the medallion
  shows. The artboard's own label keeps its place and leaves room for the island.
- **Working edge**: a 2 px `--color-overlay-agent` ring just outside the artboard, a 4 px
  `--color-agent-ring` halo around it and a `--color-agent-glow` glow (`0 0 24px 2px`). Nothing
  animates. The island and edge stay until `finish_working_on_nodes` releases the artboard, or
  until the idle timeout in the contract. Nothing is drawn for agent writes outside a working
  set.
- **Incoming layers**: each top-level layer an agent adds first shows a placeholder where it
  lands: its bounds as a rounded rect (radius 6) tinted `--color-agent-ring`, a 1.5 px
  `--color-overlay-agent` outline and one `--color-agent-glow` shimmer band crossing it left to
  right, while the layer itself is hidden. After 450 ms the layer fades in (320 ms) and the
  placeholder fades out (400 ms). A layer an agent edits (styles, text, moves, vectors,
  overrides, visible props; not a rename) gets the same placeholder flash over it, without
  being hidden. With reduced motion layers appear at once and the placeholder only fades.
- **Inspector header**: the agent avatar comes after the human collaborators. It is 22 px, a
  **rounded square** (radius `--radius-md`) in `--color-agent` holding the 16 px medallion, using
  the existing overlap rule (−4 px, 2 px `--color-surface` ring). Squares mean
  non-person (as with team marks); circles are people. Tooltip: "Claude Code (agent)".
- **MCP section (connected)**: header "MCP" with a `--color-success` dot and "Connected" on the right.
  Then an agent row (32 px, gap 8): agent avatar 22, name 12/500 ("Claude Code"), activity 11
  muted: "Editing Pricing — Desktop" while it holds a working set, otherwise "Idle · 2 min ago".
  Then the full-width secondary button "Agent settings", which opens the dialog (34). For each
  extra agent, add one row.
- The canvas content and the rest of the chrome are unchanged from 32, except the active tool:
  Select.

### 36 Home — Agents connected

The sidebar "Using agents" card in its connected state replaces the "Get started" content. The
card frame and header are unchanged; the minus still collapses the card.

- Agent rows (36 px, gap 8, padding-top 6): agent avatar 22 + name 12/500 + last activity 11
  muted.
  - Active agent: `--color-agent` avatar with an 8 px `--color-success` presence dot
    (bottom-right, offset −3, 2 px `--color-background` ring), "Active now · Baren"
    (the file it is working in).
  - Idle agent: muted avatar (`--color-muted`, glyph `--color-foreground-muted`), "Last active
    2 hours ago".
  - Show at most 3 rows, most recent first, then "+N more" (11 muted).
- Button: the card's existing secondary button (`--color-muted`, 30 px) with the label "Agent settings" and no
  chevron. It opens the dialog (34) at app level.
- If the server is on but no agent has connected yet, the card keeps "Get started".

### D34 / D35 (dark)

Chrome only, with the values from `design/tokens.dark.css` plus the dark agent values above. The dialog
uses `#1A1A1A`, the dark `--shadow-popover`, and the `--color-scrim-subtle` backdrop
(`#00000080`). The switch "on" is a `#EDEDED` track with a `#1A1A1A` knob. The active segment is
`--color-segment-active`. The code block is `#262626`. The footer is `#202020`. "Done" uses
`--color-primary`. In D35 the component labels on the canvas use the dark `--color-component`
`#9B7DFF`. Canvas content (the 05 boards, pricing artboard and component mains) is pixel-identical to light.
