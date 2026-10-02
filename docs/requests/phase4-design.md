# Phase 4 — design workstream notes and requests

New artboards 34, 35, 36, D34 and D35. PNGs are in `design/reference/`, listed in
`design/screens.json`. Full token and per-artboard notes: `docs/phase4/design-tokens.md`.
Existing artboards are unchanged.

## Request 1 — agent accent tokens (owner: UI kit / editor, `packages/ui` tokens.css, additive)

| Token                   | Light                                     | Dark        |
| ----------------------- | ----------------------------------------- | ----------- |
| `--color-agent`         | `#d21f75`                                 | `#ec5a9c`   |
| `--color-agent-ring`    | `#d21f7552`                               | `#ec5a9c59` |
| `--color-agent-glow`    | `#d21f752e`                               | `#ec5a9c33` |
| `--color-overlay-agent` | `var(--color-agent)` (section 5, `:root`) | follows     |

Light mode of every existing screen is unchanged (these are new names only). `tokens.test.ts` needs both
values for each colour token. `design/tokens.dark.css` is deliberately left unchanged for now,
because the test requires it to equal `packages/ui`. Mirror the dark values there after the tokens land.

## Request 2 — "agent working" overlay on the canvas (owner: canvas; data from the MCP/desktop workstream)

Artboard 35 draws, for each top-level artboard in an agent's working set:

1. a badge at the right end of the artboard label row: an 18 px pill, radius 4,
   `--color-overlay-agent`, a white 10 px sparkle + "<clientInfo.name> is working" (11 px /
   500). The label row grows from 14 to 18 px with the name bottom-aligned, so the artboard
   itself does not move;
2. a 2 px `--color-agent-ring` ring outside the artboard and a `--color-agent-glow` glow (18 px
   blur, 2 px spread);
3. a bright sweep segment that travels around the ring (one lap every 2.4 s, linear). With
   `prefers-reduced-motion` the sweep is replaced by a static 1.5 px ring in full
   `--color-overlay-agent`.

The canvas needs, per page, a list of `{ artboardId, agents: string[] }` (presence-like,
transient, never in the document). It is set by the MCP tool calls and cleared by
`finish_working_on_nodes` or the idle timeout.

## Request 3 — Switch control (owner: UI kit, `packages/ui`)

The dialog's enable/disable toggle needs a Switch, which does not exist yet. Spec: 28 × 16, radius full, padding 2;
on = `--color-foreground` track + `--color-background` knob (12 px) on the right; off =
`--color-track` track + `--color-thumb` knob on the left; knob shadow `--shadow-thumb`; 140 ms
`--ease-out` knob slide; focus ring `--shadow-focus`; `role="switch"`, `aria-checked`. No new
tokens.

## Request 4 — agent avatar (owner: UI kit, `Avatar`)

Add an `agent` variant: a 22 px rounded square (radius `--radius-md`), `--color-agent` fill and a
white 12 px sparkle (lucide `Sparkle`, filled) in place of the initial. An `idle` modifier uses
`--color-muted` with a `--color-foreground-muted` glyph. An optional 8 px `--color-success`
presence dot sits bottom-right with a 2 px `--color-background` ring. Agents appear after the
human collaborators in the inspector header, with the same overlap rule (−4 px, 2 px surface
ring).

## Notes for the desktop / MCP workstream (no request)

- The URL and port in 34 (`http://127.0.0.1:29980/mcp`) are placeholders. The dialog shows
  whatever the Phase 4 contract fixes. The token is masked as `••••••••` plus its last 4 characters
  until Reveal is pressed. Copy always copies the unmasked snippet.
- The snippets for the Cursor, Codex and Other segments are specified (not drawn) in
  `docs/phase4/design-tokens.md` §2. The Cursor and Codex formats were checked against their
  current docs.
- The MCP section's connected state (35) and the home card's connected state (36) need the
  connected clients' names (`clientInfo.name`), each client's current working set (artboard
  name) and its last-activity time.

## Resolution (integration, 2026-10-02)

Requests 1–4 were built by the ui workstream (agent tokens, the canvas overlay, Switch, the
agent/idle Avatar). The dark agent tokens are now mirrored in `design/tokens.dark.css`
(section 5). The port is fixed at 29170 (contract §3.3); redrawing 34/D34's snippet and drawing
the Cursor/Codex/Other tabs and the Off/Connected/Error states remain design follow-ups
(`docs/STATUS.md` known issue 23).
