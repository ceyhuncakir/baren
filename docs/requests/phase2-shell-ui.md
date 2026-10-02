# Phase 2 — shell-ui notes and requests

shell-ui owns `apps/desktop/src/renderer/**` (except `editor/**`, `types/bridge.d.ts`,
`lib/assets.ts`) and `apps/desktop/tests/visual/screens.spec.ts`. Accounts are email + password
only: the Google/GitHub buttons, the "or with email" divider and the "Coming soon" wrapper are
gone from 18/19, with their code (`OAuthButtons`, `.soon`).

## What the renderer does now (for the contract / STATUS)

- **Routes:** `#/auth/forgot` (22, title "Forgot password") and `#/auth/reset` (23, title
  "Reset password"). Neither is remembered as a last route. `#/auth/reset` without a pending
  reset redirects to `#/auth/forgot` (fixture mode opens it with the design's account).
- **Forgot → reset:** "Forgot password?" on 18 carries the typed email to 22. 22 calls
  `api.forgotPassword(email)` and always moves on (the server answers 204 for unknown
  addresses). 23: 6-digit code (spaces/dashes ignored), a complete code moves focus to "New
  password" (auto-advance), strength meter + hint as in 19, "Resend in 0:24" (30 s cooldown),
  `api.resetPassword` → signed in (toast "Password changed. Other devices were signed out.").
  Error codes go to their field (`invalid_code`/`code_expired`/`too_many_attempts` → code,
  `weak_password` → password, others → form line).
- **Change password:** Account menu → Preferences (also Ctrl+,) → "Change password…" dialog:
  current + new password (strength meter), `api.changePassword({ currentPassword, newPassword })`.
  `current_password_required` / `invalid_credentials` (400) show on the current-password field;
  the session is kept.
- **Email-aware copy** (`lib/providers.ts`, `providers()` fetched once per window, `null` while
  unknown = the designed email copy):
  - `email: true` — 20/22/23 as designed; 20's tip now reads "Can't find it? Check your spam
    folder. The email comes from Baren." (see the design request below).
  - `email: false` (log/file transports) — 20 title "Enter your code", leads say "Ask the server
    admin for the 6-digit code for …", the tip says the admin finds it in the server log; resend
    toasts say a new code was issued.
  - Invite dialog: with an address and email delivery the button is "Send invite" (toast
    "Invite sent to …", the link is still shown); otherwise "Create invite link" and the link is
    copied. Members → "Resend invite" calls `api.resendInvite` for email invites (toast "Invite
    sent again to …", or the rotated link is copied when the server has no email). Link-only
    invites have no address: their action reads "New link" (fresh invite, old one revoked).
- **Updates:** `state/updates.ts` mirrors `bridge.updates`. The card of artboard 25 (fixed,
  `left: 256px; bottom: 16px`, 340 wide) shows whenever the state is `ready`; Restart →
  `updates.install()`, Later → hidden until the next launch (or until a newer version is ready).
  Help → "Check for Updates…" shows the build's version on the right (`v0.1.0`) and, after the
  user starts a check, the same card reports checking → downloading (progress bar, percent) →
  up to date (auto-hides after 5 s) / error (Try again, Close) / "Updates are off in this
  build" (`disabled`). Background checks are never announced, except `ready`. While ready, the
  Help title carries the 6 px selection dot and the item reads "Restart to Update (0.2.0)…";
  while downloading it reads "Downloading Update… 42%" (disabled).
- **Theme:** `state/theme.ts`. `installTheme()` runs first in `main.tsx` (before `createRoot`)
  and sets `<html data-theme>` from `bridge.theme.initial`, then follows `theme.onChange`. The
  Account menu's Light/Dark/System control and Preferences drive `bridge.theme.setPreference`
  (the old localStorage `theme` key is no longer read). The smoke report now shows
  `dataTheme: "light"`.
- **Fixture / mock:** `lib/mockApi.ts` implements `providers` (`{ email: true }`, option
  `emailDelivery`), `forgotPassword`, `resetPassword` (any 6 digits; the new password is then
  required at login), `changePassword` (checks the current one once a password was set),
  `resendInvite` (rotates the token like the server), `uploadAsset`/`downloadAsset`/`hasAsset`
  (in memory, per file). Fixture mode defaults the theme preference to `light` (17 shows
  "Light") unless `?theme=` is given. `assets.put` in the mock bridge now hashes with blake3
  (lazy chunk), as images asked. Test hooks: `setUpdateStatus`, `updateInstalls`,
  `setSystemDark`.

## Requests

### dark-theme / `packages/ui`

- OAuth leftovers in `packages/ui` (not owned by shell-ui): `GoogleIcon`, `GitHubIcon`, the
  playground's "Continue with Google/GitHub" specimens and the `Button.module.css` comment that
  mentions them. Nothing in the app uses the two icons any more.
- New renderer styles to review for dark (tokens only, no literal colours):
  `app/UpdateToast.module.css` (`--shadow-popover`, `--color-selection-subtle`; the success
  disc is `color-mix(in srgb, var(--color-success) 14%, transparent)`),
  `app/Preferences.module.css`, the Help-title dot in `app/App.module.css`
  (`box-shadow: 0 0 0 1.5px var(--color-surface)`), `team/Team.module.css .inviteNote`,
  `auth/Auth.module.css .fieldsReset/.back`.
- Four glyphs drawn in 22/23/25 live in `renderer/components/icons.tsx` (`KeyIcon`,
  `LockKeyholeIcon`, `ArrowLeftIcon`, `DownloadIcon`, made with `createIcon`). They could move
  into `@baren/ui`'s icon set.

### platform

- The macOS native menu's "Check for Updates…" calls `updates.check()` in main directly, so the
  renderer cannot tell it from a background check and shows no feedback there. The renderer now
  also accepts an `baren:command` event with detail `app.checkForUpdates` (it runs the same
  action as the HTML Help menu); sending that to the focused window instead would give macOS
  the same checking / up to date / error card.

### design

- **20 Verify email:** the tip "You can also click the link in the email — we'll bring you back
  to the app automatically" promises a link that the verification email (26, and the server's
  template) does not contain. The app shows "Can't find it? Check your spam folder. The email
  comes from Baren." instead (20 still compares at 1.17 %). Please update the
  artboard's copy, or add a link to 26 and the server template.
- **13 Help menu:** the app shows its version (`v0.1.0`, muted, in the shortcut column) next to
  "Check for Updates…" (13 still compares at 3.86 % of the menu region). Worth drawing, as
  well as the "Restart to Update (0.2.0)…" / "Downloading Update… 42%" item states.
- The `email: false` copy variants (verify "Enter your code", the "ask the server admin" leads)
  and the update card's other states (checking, downloading with progress, up to date, error)
  are not drawn; they reuse 20/23/25's layout.

### ARCHITECTURE.md (proposed additions)

- Routes list: add `#/auth/forgot` and `#/auth/reset`.
- `?fixture=design` also accepts `&updates=<state>` (25) and `&theme=<pref>`; without `theme`
  the fixture preference is `light`.
- `screens.spec.ts` has a "against a real server" block, skipped unless
  `BAREN_E2E_MAIL_DIR` is set (with `VITE_SERVER_URL` pointing at an `baren-server`
  started with `MAIL_TRANSPORT=file:<dir>`): register → verify → sign out → forgot → reset →
  sign in, and invite email + resend (rotated link) + change password.
