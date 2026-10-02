/**
 * Glyphs drawn in the Phase 2 artboards (22, 23, 25) that `@baren/ui` does not have.
 * Paths copied from the reference artboards; colours come from `currentColor`.
 */
import { createIcon } from '@baren/ui'

/** 22 Forgot password: key (lucide `key-round` with a filled bit). */
export const KeyIcon = createIcon(
  'KeyIcon',
  <>
    <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
    <circle cx="16.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
  </>,
  { strokeWidth: 1.6 },
)

/** 23 Reset password: padlock with a keyhole dot. */
export const LockKeyholeIcon = createIcon(
  'LockKeyholeIcon',
  <>
    <circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none" />
    <rect x="3" y="10" width="18" height="12" rx="2" />
    <path d="M7 10V7a5 5 0 0 1 10 0v3" />
  </>,
  { strokeWidth: 1.6 },
)

/** "← Back to sign in" (22). */
export const ArrowLeftIcon = createIcon(
  'ArrowLeftIcon',
  <>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </>,
)

/** 25 Update ready: download arrow onto a baseline. */
export const DownloadIcon = createIcon(
  'DownloadIcon',
  <>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </>,
  { strokeWidth: 2.25 },
)
