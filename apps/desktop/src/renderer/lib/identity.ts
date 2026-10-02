/**
 * Stable colors for people and teams. Other people get a palette color from their user id
 * (@baren/ui avatarColorFor); the signed-in user keeps the --color-avatar orange, as in
 * every artboard. Team marks (account menu, 17) use the team palette below.
 */
import { avatarColorFor } from '@baren/ui'

const TEAM_COLORS = ['#1A1A1A', '#C8F230', '#2F80FF', '#F04E1E', '#7C3AED', '#16833F'] as const

function hash(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h
}

export function teamColorFor(teamId: string): string {
  return TEAM_COLORS[hash(teamId) % TEAM_COLORS.length] ?? TEAM_COLORS[0]
}

/** Avatar color for a member; undefined = the default avatar token (you). */
export function memberColorFor(userId: string, selfId: string | null): string | undefined {
  return userId === selfId ? undefined : avatarColorFor(userId)
}
