/**
 * Data shown in the reference artboards (01–03, 17–21), used by the browser mock bridge and,
 * with `?fixture=design`, by the in-memory API. Times are offsets from "now" so labels read
 * exactly as designed ("Edited 4 minutes ago", "2 hours ago").
 *
 * Plain data only: thumbnails live in ./thumbnails.ts and load lazily.
 */
import type { Invite, Member, Team, User } from '@baren/sync-client/api'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface DesignFileSeed {
  id: string
  name: string
  /** How long ago the file was edited. */
  editedAgo: number
  createdAgo: number
  /** Key into ./thumbnails.ts, if the card shows a thumbnail. */
  thumbnail: string | null
}

/** Artboard 01, in grid order. Scratchpad is the permanent draft (no thumbnail). */
export const DESIGN_FILES: readonly DesignFileSeed[] = [
  {
    id: 'f-scratchpad',
    name: 'Scratchpad',
    editedAgo: 120 * DAY,
    createdAgo: 400 * DAY,
    thumbnail: null,
  },
  {
    id: 'f-baren',
    name: 'Baren',
    editedAgo: 5 * SECOND,
    createdAgo: 30 * DAY,
    thumbnail: 'baren',
  },
  {
    id: 'f-acme',
    name: 'acme',
    editedAgo: 4 * MINUTE + 5 * SECOND,
    createdAgo: 90 * DAY,
    thumbnail: 'acme',
  },
  {
    id: 'f-acme-darkmode',
    name: 'acme darkmode',
    editedAgo: 28 * DAY + HOUR,
    createdAgo: 60 * DAY,
    thumbnail: 'baren-darkmode',
  },
  {
    id: 'f-logo',
    name: 'logo',
    editedAgo: 47 * DAY + HOUR,
    createdAgo: 70 * DAY,
    thumbnail: 'logo',
  },
  {
    id: 'f-landing-page',
    name: 'acme – landing page',
    editedAgo: 41 * DAY + HOUR,
    createdAgo: 75 * DAY,
    thumbnail: 'landing-page',
  },
  { id: 'f-cv', name: 'cv', editedAgo: 79 * DAY + HOUR, createdAgo: 200 * DAY, thumbnail: 'cv' },
  {
    id: 'f-dashboard',
    name: 'acme dashboard',
    editedAgo: 48 * DAY + HOUR,
    createdAgo: 110 * DAY,
    thumbnail: 'dashboard',
  },
]

/** "Recents" means recently opened: the design's order is not sorted by edit time. */
export const DESIGN_RECENT_ORDER: readonly string[] = DESIGN_FILES.slice(1).map((f) => f.id)

export const DESIGN_SCRATCHPAD_ID = 'f-scratchpad'

export const DESIGN_USER: User = {
  id: 'u-ceyhun',
  name: 'ceyhun cakir',
  email: 'ceyhun@example.com',
  createdAt: 0,
}

/** Ids chosen so the derived team marks are #1A1A1A and #C8F230, as drawn in 17. */
export const DESIGN_TEAM_ID = 't-ceyhun-4'
export const DESIGN_LABS_TEAM_ID = 't-labs-1'

export function designTeams(now: number): Team[] {
  return [
    {
      id: DESIGN_TEAM_ID,
      name: "ceyhun's Team",
      role: 'admin',
      fileAccess: 'link',
      memberCount: 2,
      createdAt: now - 120 * DAY,
    },
    {
      id: DESIGN_LABS_TEAM_ID,
      name: 'Acme Labs',
      role: 'editor',
      fileAccess: 'members',
      memberCount: 4,
      createdAt: now - 60 * DAY,
    },
  ]
}

/** Artboard 02. Defne's id hashes to the #1A1A1A avatar color. */
export function designMembers(now: number): Member[] {
  return [
    {
      userId: DESIGN_USER.id,
      name: DESIGN_USER.name,
      email: DESIGN_USER.email,
      role: 'admin',
      joinedAt: now - 120 * DAY,
      lastSeenAt: now,
      online: true,
    },
    {
      userId: 'u-defne-4',
      name: 'Defne Aydın',
      email: 'defne@example.com',
      role: 'editor',
      joinedAt: now - 40 * DAY,
      lastSeenAt: now - 2 * HOUR - 5 * MINUTE,
      online: false,
    },
  ]
}

export function designInvites(now: number): Invite[] {
  return [
    {
      id: 'inv-mert',
      role: 'viewer',
      email: 'mert@example.com',
      maxUses: 1,
      uses: 0,
      expiresAt: now + 12 * DAY,
      createdAt: now - 2 * DAY,
      invitedBy: DESIGN_USER.id,
    },
  ]
}

/** Artboards 19/20: the account being created and verified. */
export const DESIGN_SIGNUP = {
  name: 'Defne Aydın',
  email: 'defne@example.com',
  /** 20 shows "Resend in 0:24": the code went out six seconds ago. */
  codeSentAgo: 6 * SECOND,
} as const

/** Artboard 21. */
export const DESIGN_DEVICE_CODE = 'KQ7-4XM'
