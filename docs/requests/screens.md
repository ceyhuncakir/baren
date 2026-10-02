# Contract notes from screens

screens owns `apps/desktop/src/renderer/**` (except `editor/**`) and
`apps/desktop/tests/visual/screens.spec.ts`. Everything below is built and tested. Items marked
**request** need another workstream or a contract change at integration.

## 1. How the shell hosts the editor (editor)

- `/file/:id` renders `<EditorScreen fileId onExit />` **below the shared 36 px title bar**,
  in a flex column that fills the rest of the window (`.editor > *` gets `flex: 1`). Do not
  render a second title bar or menu bar.
- The title bar shows `FileMeta.name` by default. To show something else (for example right
  after a rename through `setDocName`), call `useWindowTitle(name)` from
  `renderer/lib/windowTitle.ts`. It applies while the component is mounted.
- `onExit()` returns to the last Recents/Files/Archive/Team screen and reloads the file list.
- The editor chunk is loaded with a Suspense-free loader (`app/screens.ts`) and **warmed while
  the app is idle** after the first screen, so opening a file does not wait for the chunk.
  React 19 throttles Suspense reveals by up to ~300 ms, which is why `React.lazy` is avoided.
- The shell records "opened" for Recents (`markOpened`). Recents is ordered by **last opened**
  (the artboard-01 order is not edit time); "Edited x ago" uses `FileMeta.updatedAt`.
- **Request (editor):** write thumbnails with `bridge.files.setThumbnail(id, png)`. The card
  draws them in a 247×164 CSS px box with `object-fit: contain` (494×328 for 2× screens).
  Files without a thumbnail show the empty canvas, as artboard 01 draws the Scratchpad.
- **Request (editor): keyboard.** The shell binds `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`,
  `Ctrl+X/C/V/A`, `Delete` and `Backspace` once, on `window` (bubble phase), and calls
  `runCommand('edit.*')` when that command is registered, no text field has focus, no modal
  dialog is open and the event was not `defaultPrevented`. Register handlers with
  `registerCommand` instead of binding these keys, or call `preventDefault()` if you handle
  one yourself; otherwise the command runs twice. The Edit menu enables items from the same
  registry (`useCommandEnabled`).

## 2. Command registry additions (contract)

`COMMAND_IDS` now also contains the Help links sent by desktop-shell's macOS menu:
`help.documentation help.videoTutorials help.releaseNotes help.discord help.slack help.reddit
help.twitter`. The shell registers them (open the URL with `bridge.shell.openExternal`) and
forwards `baren:command` DOM events to `runCommand`. `isCommandId(value)` narrows untrusted
strings.

## 3. Desktop integration (desktop-shell)

- `baren:ready` is dispatched once the first screen is interactive: Recents/Files after the
  real file list renders, or the sign-in form, the team screen, the invite screen, or the
  editor chunk. It is dispatched from a passive effect without `requestAnimationFrame`, because
  hidden windows throttle frames. Measured with `pnpm smoke` (native backend):
  `coldStartMs` **321–402 ms** (it was ~1.37 s while waiting on rAF plus a lazy auth chunk).
- On Linux/Windows the renderer binds the main-process shortcuts (`Ctrl+Shift+N`, `Ctrl+Q`,
  `Ctrl+R`, `Ctrl+Shift+R`, `Ctrl+Shift+I`, `F11`, `Ctrl+M`, `Ctrl+W`) **only on the mock
  bridge** (browser). Inside Electron the menus just display them and call `bridge.app.*` /
  `bridge.window.*` when clicked.
- macOS: the HTML menu bar and the drawn window controls are hidden; a 72 px spacer leaves
  room for the traffic lights. This was not run on macOS.
- `baren://invite/<token>` opens the invite screen.
- Proposal, agreeing with desktop-shell §4.2: typed `bridge.onCommand(cb)` and `bridge.app.ready()`
  would replace the two DOM events.

## 4. Requests to ui-kit

1. **`text-rendering` on form controls.** Chromium's UA stylesheet sets
   `text-rendering: auto` on `button`, `input`, `select` and `textarea`, so text in
   buttons (menu titles, nav items, file cards, tabs) does not get `global.css`'s
   `geometricPrecision`. Please add `button, input, select, textarea { text-rendering: inherit }`
   to `global.css`. screens works around it in `app/App.module.css` (scoped to the app root).
2. **`MenuBar` drops a passed `ref`.** It spreads `...rest` after its own `ref={barRef}`, so a
   caller's `ref` replaces the internal one and breaks arrow-key switching. Please merge refs.
   An imperative `open(label, { via: 'keyboard' })` would also allow Alt+letter mnemonics;
   screens implements Alt-to-focus by querying `[data-menubar-item]`.
3. **Menu title widths.** The reference designs size text frames to whole pixels
   (`ceil(text) + padding`), so File/Edit/View/Window/Help sit at x = 8/48/90/139/207. With
   fractional advances Chromium puts them up to 2 px to the left, and the menus anchored under
   them move too. screens snaps the title widths once per font load (`useWholePixelTitles` in
   `app/AppMenuBar.tsx`). This could move into `MenuBar`.
4. **`AuthHeading` lead line height.** Sign in and Create account use 14/20; Verify uses 14/22
   (the component's value). screens overrides the first two with `.leadCompact p`. A `lead`
   size prop would be cleaner.
5. **No modal dialog.** screens built `renderer/components/Dialog.tsx` (focus trap, Escape,
   backdrop click, focus restore) for invite, rename, create team, confirmations and
   shortcuts. A ui-kit `Dialog` would let the editor share it.
6. **Disabled buttons cannot show tooltips** (`pointer-events: none`). The "coming soon"
   OAuth buttons use `aria-disabled` plus a `title` on a wrapper.
7. **`TableHeaderCell` couples the caret to `aria-sort`.** Artboard 02 draws a down caret for
   A→Z order; screens passes `sort="desc"` and overrides `aria-sort="ascending"`.
8. The account menu's Theme switch (Light/Dark/System) is stored, but there are no dark
   tokens yet.

## 5. Requests to rust-core / desktop-shell (bridge)

- **`files.import(snapshot, name)` and `files.setRemote(id, teamId, remoteId)` on the
  bridge.** rust-core's `CoreHandle` has `importFile` and `setFileRemote`, but the bridge does
  not expose them. Without them, team files listed by the server (`api.files.list`) cannot be
  opened locally, so the Files view shows local files only.
- **Scratchpad identity.** The permanent draft is the file whose id is stored in
  `localStorage['baren.scratchpad']` (or, the first time, the oldest file named
  "Scratchpad"). Clicking the card creates it if it does not exist. A `pinned`/`kind` field on
  `FileMeta` would make this survive a profile reset.

## 6. Server-side gaps visible in the screens (sync-server)

- No SMTP: "Resend invite" creates a new link for the same email and role, revokes the old one
  and copies the new link. The Verify screen's "click the link in the email" callout is the
  designed copy, but there is no such link yet.
- "Forgot password?" and Google/GitHub sign-in show "coming soon".

## 7. Renderer conventions worth recording in ARCHITECTURE.md

- **Hash routes** (`#/recents`, `#/files`, `#/archive`, `#/team/members`, `#/team/settings`,
  `#/auth/sign-in|register|verify|browser`, `#/invite/<token>`, `#/file/<id>`): the `app://`
  scheme serves files and has no SPA fallback. The last app route is restored when a window
  opens without one.
- **`?fixture=design`** (browser only, never in Electron): the mock bridge starts signed in
  and an in-memory fake server (`lib/mockApi.ts`) serves the artboard data, so every screen
  renders without a server. The browser mock always seeds the artboard-01 files and keeps its
  session token in `sessionStorage`.
- **`window.__barenTest`** exists whenever the mock bridge is active: `enableCommand`,
  `commandCalls`, `emitDeepLink`, `openedUrls`, `createFiles`. Playwright uses it because
  dynamic imports stop returning the app's module instances once Vite hot-reloads a module.
- The foundation smoke test asserts `data-testid="app-placeholder"`. The shell keeps a hidden
  diagnostics node with that test id ("Baren · linux · mock bridge"). Integration can
  update `tests/visual/smoke.spec.ts` and remove it.
