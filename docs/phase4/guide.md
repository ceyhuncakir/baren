# Baren MCP — agent guide (served by `get_guide`)

This file is the single source of the text the MCP server returns from `get_guide` and of the
`instructions` string in its `initialize` result (docs/phase4/contract.md §4.10, §6.1). The
server imports it with `?raw` and splits it at the `<!-- topic: <name> -->` markers below; the
text between a marker and the next one (trimmed) is that topic's body. Nothing above the first
marker is served. Edit the wording here only (contract change requests go to
`docs/requests/phase4-<workstream>.md`).

Topics: `server-instructions` (not listed; the `initialize` instructions),
`baren-mcp-instructions`, `mobile-status-bar`, `images`, `code-export`, `image-generation`.

<!-- topic: server-instructions -->

Baren is a local-first design tool. Its canvas is real HTML and CSS: every layer is a
DOM element with inline styles, laid out with flexbox. This MCP server lets you read the user's
design files and write to them live — the user watches your changes appear on their canvas, and
collaborators in a shared file see them too.

Before anything else, load the full guide once per session: get_guide({ topic: "baren-mcp-instructions" }).

- Start a file with get_basic_info (pages, artboards and their sizes, fonts, tokens) and get_selection (what the user is focused on). Omit fileId to use the file the user is looking at; call list_files to find others.
- A <baren-selection> block in the user's message is layers they copied in Baren to point at them: pass its fileId and nodeId values straight to the tools instead of searching.
- pageId defaults to the page the user is viewing. Pass it to work on another page without moving the user.
- Write in small steps: each write_html call adds about one visual group (a header, one row, a button bar). Prefer duplicate_nodes + update_styles + set_text_content when that is faster than new HTML.
- Use flexbox, padding and gap. Never margin, grid or tables. Use the file's design tokens as var(--token).
- Call get_font_family_info before your first typographic styling.
- Review with get_screenshot after each meaningful change. When content clips, set the artboard height to "fit-content" instead of guessing a new height.
- When you are done creating or editing, you MUST call finish_working_on_nodes.
- Collaborators leave comments on layers: get_basic_info counts them (openComments per artboard). Read them with get_comments before editing an artboard that has some and whenever the user mentions comments or feedback; reply_to_comment when you addressed one, resolve_comment only when it is fully handled or the user asks.
- Never show node IDs to the user.
- For code, use get_jsx, get_computed_styles and get_tokens for exact values — never read sizes or colors off a screenshot.

<!-- topic: baren-mcp-instructions -->

# Working in Baren

Baren is a design tool whose canvas is real HTML and CSS. Every layer is a DOM element
with inline styles; frames lay out their children with flexbox. You build designs by writing
HTML into the canvas, and the user sees each change appear the moment you make it. In a shared
file, their collaborators see it too, and your name appears next to theirs.

## 1. Orient yourself first

1. Call `get_basic_info` once per file. It lists the pages, the artboards with their sizes and
   positions, the font families in use and the design tokens. Artboard width tells you the
   target: about 390 px is a phone, 768 px a tablet, 1440 px a desktop.
2. Call `get_selection` to see what the user has selected. If nothing is selected and the
   request is ambiguous, ask the user which artboard to work on.
   A `<baren-selection>` block in the user's message is layers they copied in Baren (Copy as →
   Agent context): that is what "this" means. Pass its `fileId` and each `nodeId` — or the
   `data-node-id` of an element inside, for a nested layer — straight to the tools. Its JSX is a
   snapshot from when they copied, so read the layer again before you change it.
3. Use `get_tree_summary` for the structure of an artboard (cheap), `get_children` for one
   level, and `get_node_info` for details and text content.
4. Every file-scoped result starts with a header: the file id, the file name and a hash of the
   file's tokens. If the file id is not the one you meant, stop and pass the right `fileId`.
   If the token hash changed since you last read tokens, someone edited them: call
   `get_tokens` again before relying on token names.

`fileId` is optional everywhere: without it, the tool uses the file in the window the user last
used. `pageId` is optional: without it, page-scoped tools use the page the user is viewing.
Pass `pageId` to work on another page without disturbing the user — you cannot switch the page
they are looking at.

Node ids are opaque strings. Ids of layers inside a component instance contain slashes; you can
read them and change their styles and text (that creates an override on the instance), but you
cannot add children to them. An id does not survive the user undoing the creation or deletion
of its layer: if a tool reports an unknown id after the user pressed undo, look the layer up
again.

## 2. Brief before a new design

Unless the user gave you a detailed design system, post a short brief in the chat before your
first write. It is part of the deliverable:

- **Mood**: two or three candidate moods, the one you commit to, and why. A mood is a physical
  scene or register (mineral, maritime, bookish, signage, gallery, terminal, alpine…); derive
  every colour from an object in that scene.
- **Palette**: five or six hex values with their roles.
- **Type**: family, weights and a size scale.
- **Direction**: one sentence on the overall look.

If the file already has tokens, use them instead of inventing a palette.

## 3. Write in small steps

The user watches the canvas while you work. A long silence followed by a finished screen feels
like a black box; seeing content appear every few seconds builds trust.

- Each `write_html` call adds roughly **one visual group**: a header, one list row, a button
  bar, a card shell, a paragraph block. More than about 15 lines of HTML in one call is too
  much — split it.
- Build containers first, then fill them: a card is the shell, then the header, then each row,
  then the footer, as separate calls into the shell (`mode: "insert-children"`).
- For repeated items, write the first one, then use `duplicate_nodes` and change the copies
  with `set_text_content` and `update_styles`. The `descendantIdMap` in the result gives you the
  ids inside each copy without another lookup.
- Reuse what exists: `<x-baren-clone node-id="…" style="…" />` inside `write_html` copies an
  existing layer, with your inline styles applied to the copy.
- Use `move_nodes` to reorder or reparent. It keeps ids; never delete and rewrite a layer just
  to move it.
- Every tool call is one undo step for the user. Do not split one logical change into many
  tiny calls just to be safe, and do not batch a whole screen into one call either.

## 4. HTML and CSS rules

- **Inline styles only** (`style="…"`). `class`, `<style>` blocks and external stylesheets are
  ignored. Use the `layer-name` attribute to name layers: `<div layer-name="Hero">`.
- **Flexbox is the layout system.** Use `display: flex`, `flex-direction`, `gap`, `padding`,
  `align-items`, `justify-content`, `flex-grow`/`flex-shrink`/`flex-basis` and fixed or
  `fit-content` sizes.
- **Do not use** `margin`, `display: grid`, `display: inline`, `float` or HTML tables. Use
  padding and gap for spacing. (They are accepted with a warning, but the user cannot edit
  them in the inspector.) `display: block` is fine for simple leaves (text, decorative
  shapes), not for layout containers.
- **Absolute positioning** is fully supported (`position: absolute` + `left`/`top`) and suits
  decorative elements. Do not cover a whole artboard with one absolute element: it blocks the
  user's clicks on everything underneath.
- Everything is `box-sizing: border-box`.
- **Text**: an element that contains only text becomes one text layer, with that element's
  styles. Rich text is not supported: a text layer has one style, so `<p>Hello <b>you</b></p>`
  becomes one text layer "Hello you" (with a warning). Put differently styled runs in separate
  elements inside a flex row: in a `display: flex` element every child element stays its own
  layer, so `<nav style="display: flex; gap: 24px"><a>Docs</a><a>Pricing</a></nav>` is a frame
  with two text layers. `<br>` is a line break. Use `<pre>` or `white-space: pre` for code and
  indented text.
- **Colours**: any CSS colour (hex, rgb/rgba, hsl, oklch, oklab, `color-mix()`). To fade a
  token colour: `color-mix(in srgb, var(--color-primary) 40%, transparent)`.
- **Icons**: inline `<svg>` (sanitised: no scripts, no external references). `fill` and
  `stroke` may use `var(--token)` and `currentColor`. Never use emoji as icons.
- **Images**: see `get_guide({ topic: "images" })`. In short: `<img src="/absolute/path.png">`,
  `https://…`, `data:` URIs, or an existing image's `baren-asset://<hash>`. AI image
  generation is not available.
- Results of `write_html` and `update_styles` list `warnings` for anything that was dropped or
  changed. Read them.

## 5. Artboards

- Create one with `create_artboard` and the size the user asked for. Defaults: desktop
  1440 × 900, tablet 768 × 1024, phone 390 × 844 (add a status bar:
  `get_guide({ topic: "mobile-status-bar" })`).
- Artboards are flex columns with a white background unless you say otherwise. Without `left`
  and `top` the artboard is placed in a free spot next to the other artboards (80 px apart).
  Setting `left`/`top` with `update_styles` moves it.
- The height is a starting point. When content clips at the bottom, set `height: "fit-content"`
  with `update_styles` instead of guessing a new fixed height.

## 6. Design tokens

- Always use the file's tokens when it has them: `color: var(--color-foreground)`,
  `gap: var(--spacing-4)`, `border-radius: var(--radius-md)`.
- Create a token set with `create_tokens` in Tailwind v4 namespaces: `--color-*`,
  `--spacing-*`, `--radius-*`, `--font-*` (families), `--font-weight-*`, `--text-*` (sizes),
  `--leading-*` (line heights, px), `--tracking-*` (letter spacing, em), `--opacity-*`,
  `--container-*`, `--breakpoint-*`. Keep the set small but cover every namespace you use.
  Order colours semantic first (neutrals, then primary, secondary, accents); order other
  types from small to large.
- `set_tokens` renames (references are updated across the file), changes values or deletes.
  Alias a token with `var(--other-token)` as its value.

## 7. Typography

- Call `get_font_family_info` before your first typographic styles in a session. Fonts that
  render identically for every collaborator: the bundled **Inter** (variable, weights 100–900)
  and **JetBrains Mono** (400, 500, 600), and every **Google Fonts** family (Geist, Roboto,
  Playfair Display…): Baren downloads the ones a design uses on each computer. Fonts that are
  only installed on this computer work too, but collaborators without them see a fallback.
- Prefer the families `get_basic_info` reports unless the user asks otherwise.
- Font sizes in px. Letter spacing in em (unless the design already uses px). Line height in px,
  or a unitless ratio that does not produce sub-pixel line boxes. Text without a line height
  uses the font's normal line height (about 1.2 × the font size), as in a browser; set one on
  headings and body text so the rhythm is deliberate.
- Avoid text at 12 px or below except in dense productivity UI or uppercase labels.

## 8. Review checkpoints — mandatory

After each new section, call `get_screenshot` on it and judge it as a senior designer would.
Summarise the checklist in one line and fix what you find before moving on:

- **Spacing**: uneven gaps, cramped groups, accidental empty areas. Is there a rhythm?
- **Typography**: hierarchy between heading, body and caption; readable sizes; line height.
- **Contrast**: text that is hard to read, elements that melt into their background.
- **Alignment**: elements that should share a vertical or horizontal lane. In repeated rows,
  give icons and trailing actions fixed-width slots (`width` + `flex-shrink: 0`), even when a
  slot is empty — `gap` alone does not align columns across rows.
- **Artboard fit**: content clipped at the artboard edge → `height: "fit-content"`.
- **Repetition**: grid-like sameness; vary scale, weight or spacing.

Screenshots are 1× by default, which is enough for layout and colour. Use `scale: 2` only to
read small text; for more detail, screenshot a child layer. Fix problems with targeted edits —
never delete a whole piece of work and start over unless there is truly no other way.

## 9. Design quality

The people using Baren care about craft.

- Restraint: fewer elements, each with a purpose. When unsure whether to add or remove, remove.
  White space is a feature.
- Give even minimal designs a warm, human touch.
- Vary spacing on purpose: tight to group, generous to let key content breathe.
- Prefer scale contrast and asymmetry (a very large headline beside small muted text) to
  evenly spaced sameness. Pair heavy display weights with light or regular labels; tighten
  tracking slightly on large type, open it on small caps.
- One intense colour moment is stronger than five. Text contrast is not negotiable.
- Pure white is the everyday ground for product UI, dashboards, docs and marketing pages; use
  tinted off-whites only when the mood calls for them (candlelit, bookish, sun-bleached).
  Avoid the worn-out pairings: warm off-white with terracotta or neon, and dark navy or
  charcoal with electric purple, lime or teal.
- Keep information on surfaces rather than boxing everything in cards. Avoid heavy gradients
  and shadows unless asked.
- When asked for several directions, make them genuinely different points of view.
- For playful, consumer or marketing work, one or two playful devices (a duo of accents, a
  tilted sticker, an offset shadow, a hand-drawn mark, quippy copy) go a long way.
- Use realistic placeholder copy. If an example needs a design tool, use Baren.

## 10. Working alongside the user

- While you edit an artboard, it shows a "working" badge with your name. When you finish, you
  **must** call `finish_working_on_nodes` — with the artboard ids you worked on, or with no
  ids to release everything. Badges also clear by themselves after two minutes without a call.
- The user can undo each of your tool calls separately (Ctrl+Z / ⌘Z) and may edit the same
  artboard while you work. Re-read (`get_children`, `get_node_info`) before editing something
  you have not touched for a while.
- In a shared file, a viewer cannot edit: write tools then fail with `read_only`.
- Layers the user locked (and everything inside them) cannot be changed: writes to them fail
  with `invalid_target`. Ask the user to unlock the layer; never work around a lock.
- `open_file` shows a file in the app. If it answers that the app is showing its sign-in
  screen, ask the user to sign in or choose "Continue offline". Every other tool works on a
  file without opening it (pass its `fileId`).
- Never show node ids to the user; refer to layers by name ("the hero section").

## 11. Comments

- Collaborators pin comment threads on layers and artboards (or on the page): feedback,
  questions, requests. `get_basic_info` reports `comments: { open, resolved }` for the file and
  `openComments` on each artboard that has any.
- Call `get_comments` before you edit an artboard with open comments, and whenever the user
  mentions comments, feedback or "what they said". Narrow it with `nodeId` (a layer or artboard
  and everything inside it) or `pageId`; `includeResolved: true` adds resolved threads. Each
  thread says which layer and artboard it is on, where its pin is, and every message with its
  author (`kind` "user" or "agent").
- Treat open comments as requests from the team, but the user you are talking to has the last
  word: if a comment conflicts with their instructions, ask.
- When you have addressed a comment, `reply_to_comment` and say briefly what you changed ("Gap
  is 16px now, matching the cards above"). Ask in a reply when a comment is unclear.
- `resolve_comment` only when the feedback is fully handled, or when the user asks you to.
  Never resolve a thread just because you read it.
- Replies and resolutions show your name, sync to everyone at once and are not undone by the
  user's Ctrl+Z.

## 12. From design to code

Read `get_guide({ topic: "code-export" })`. In short: `get_jsx` for structure, `get_tokens`
(css or tailwind) for the theme, `get_computed_styles` for exact values, `get_fill_image` or
`export` for image assets. Screenshots are for checking your result, never a source of values.
Translate what you get into the conventions of the user's codebase.

<!-- topic: mobile-status-bar -->

# Mobile status bar

Paste this as the first child of a 390 px wide phone artboard (`write_html`,
`mode: "insert-children"`, target = the artboard). It is 54 px tall and stretches to the
artboard width. Change `color` on the outer element for a dark background (the icons use
`currentColor`).

```html
<div
  layer-name="Status bar"
  style="display: flex; align-items: center; justify-content: space-between; height: 54px; padding: 0 28px 0 36px; flex-shrink: 0; color: #000000;"
>
  <div
    layer-name="Time"
    style="font-family: Inter; font-size: 17px; font-weight: 600; line-height: 22px; letter-spacing: -0.02em;"
  >
    9:41
  </div>
  <div layer-name="Indicators" style="display: flex; align-items: center; gap: 6px;">
    <svg layer-name="Signal" width="18" height="12" viewBox="0 0 18 12" fill="currentColor">
      <rect x="0" y="8" width="3" height="4" rx="1" />
      <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
      <rect x="10" y="3" width="3" height="9" rx="1" />
      <rect x="15" y="0" width="3" height="12" rx="1" />
    </svg>
    <svg layer-name="Wi-Fi" width="16" height="12" viewBox="0 0 16 12" fill="currentColor">
      <path
        d="M8 2.6c2.3 0 4.4.9 6 2.4l1.1-1.1A10 10 0 0 0 8 1 10 10 0 0 0 .9 3.9L2 5a8.4 8.4 0 0 1 6-2.4Zm0 3.2c1.4 0 2.7.5 3.7 1.4l1.1-1.1A7 7 0 0 0 8 4.2a7 7 0 0 0-4.8 1.9l1.1 1.1A5.4 5.4 0 0 1 8 5.8Zm0 3.2c.6 0 1.1.2 1.5.6L8 11.1 6.5 9.6c.4-.4.9-.6 1.5-.6Z"
      />
    </svg>
    <svg layer-name="Battery" width="27" height="13" viewBox="0 0 27 13" fill="none">
      <rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="currentColor" opacity="0.35" />
      <rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor" />
      <path d="M25 4.5v4c.8-.3 1.5-1.1 1.5-2s-.7-1.7-1.5-2Z" fill="currentColor" opacity="0.4" />
    </svg>
  </div>
</div>
```

For a home indicator at the bottom of the artboard, add as the last child:

```html
<div
  layer-name="Home indicator"
  style="display: flex; justify-content: center; align-items: flex-end; height: 34px; padding-bottom: 8px; flex-shrink: 0;"
>
  <div style="width: 134px; height: 5px; border-radius: 100px; background-color: #000000;"></div>
</div>
```

<!-- topic: images -->

# Images

`write_html` accepts images in `<img src="…">` and in CSS `url(…)` values (`background-image`,
`background`). `update_styles` and `create_artboard` accept the same `url(…)` sources.

| Source              | Example                                                  | Notes                                                           |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Absolute local path | `/Users/ana/brand/logo.png`, `file:///home/ana/hero.jpg` | Read by the app from this computer.                             |
| Web URL             | `https://example.com/photo.jpg`                          | Downloaded once (≤ 20 MB, 15 s).                                |
| Data URI            | `data:image/png;base64,…`                                | Decoded and stored.                                             |
| Existing image      | `baren-asset://<64 hex>`                                 | An image already in the file (see `get_fill_image`, `get_jsx`). |

- Accepted: PNG, JPEG, WebP, GIF, AVIF up to 20 MB, and SVG. An SVG file or data URI becomes a
  vector layer (its markup is sanitised), not a bitmap.
- The image is stored in the file. In a shared file it is uploaded for your collaborators
  automatically.
- `<img>` without a width or height gets the image's natural size. Use `object-fit`
  (`cover`, `contain`, `fill`, `none`) and `object-position` like in CSS.
- A source that cannot be read leaves a grey placeholder layer of the right size and a warning
  in the result; replace it later with `write_html` (`mode: "replace"`) or `update_styles`.
- Relative paths are not allowed — the app does not know your working directory.
- Baren does not generate images; use solid colours, simple SVG shapes or images the user
  provides.

<!-- topic: code-export -->

# From design to code

1. `get_tree_summary` on the artboard or component to see its structure.
2. `get_jsx` on the part you are implementing. `format: "tailwind"` (default) maps values to
   the file's tokens where they match (`bg-primary`, `gap-4`, `text-sm`) and falls back to
   arbitrary values (`pb-[14px]`); `format: "inline-styles"` gives React `style` objects. The
   output is deterministic: the same design always produces the same code.
3. `get_tokens` with `format: "css"` (a `:root { … }` block) or `format: "tailwind"` (a Tailwind
   v4 `@theme { … }` block) for the theme.
4. `get_computed_styles` for exact values of specific layers: the styles as designed, with
   token references kept as `var(--…)`. Pass `resolved: true` to get the values the browser
   computes instead (tokens resolved, sizes in px).
5. Images: `get_fill_image` returns an image layer's or image fill's picture; `export` writes
   PNG, JPEG, WebP, SVG (vector and SVG layers) or PDF files to the user's Downloads folder and
   returns their paths.
6. Never take values from screenshots. Use screenshots only to compare your implementation with
   the design.
7. Follow the user's codebase: translate the exported CSS into its components, its styling
   approach and its token names. Instances of components appear expanded in `get_jsx`;
   `get_node_info` tells you which component a layer comes from.

<!-- topic: image-generation -->

# Image generation

Baren does not generate images. Use solid colours, gradients, simple SVG illustrations, or
images the user provides (`get_guide({ topic: "images" })`).
