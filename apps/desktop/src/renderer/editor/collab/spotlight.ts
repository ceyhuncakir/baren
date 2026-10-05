/**
 * Spotlight ("follow me"): a collaborator asks everyone in the file to follow them. Presence
 * carries `spotlight` (epoch ms when the spotlight started; absent when not presenting) and
 * `following` (the user id a client follows, so a presenter can count followers).
 *
 * A follower picks up the newest spotlight among the other users, when it is newer than its own
 * and not handled yet. Picking one up, or starting one's own, marks every spotlight running at
 * that moment as handled (per user and start time): breaking away (any of Follow's stop rules)
 * is never undone by the same spotlight, and an older, superseded one never pulls; a restarted
 * spotlight is a new one. When the spotlight that started a follow ends, following stops. Being pulled into a
 * newer spotlight ends this client's own: the most recent presenter wins.
 */
import type { PeerPresence } from '@baren/sync-client'
import type { EditorStore, SpotlightFollow } from '../session/store'

export type SpotlightPeer = SpotlightFollow

/** Each other user's spotlight (the newest of their windows'), newest first. */
export function activeSpotlights(
  peers: readonly PeerPresence[],
  selfUserId: string | null,
): SpotlightPeer[] {
  const byUser = new Map<string, SpotlightPeer>()
  for (const p of peers) {
    const at = p.spotlight
    if (p.userId === selfUserId || typeof at !== 'number' || !Number.isFinite(at)) continue
    const known = byUser.get(p.userId)
    if (!known || at > known.at) byUser.set(p.userId, { userId: p.userId, name: p.name, at })
  }
  return [...byUser.values()].sort((a, b) => b.at - a.at)
}

/** The spotlight to follow now, if any (`handled`: user id → the spotlight start handled). */
export function nextSpotlight(
  peers: readonly PeerPresence[],
  selfUserId: string | null,
  mine: number | null,
  handled: ReadonlyMap<string, number>,
): SpotlightPeer | null {
  const newest = activeSpotlights(peers, selfUserId)[0]
  if (!newest) return null
  if (mine !== null && newest.at <= mine) return null
  if ((handled.get(newest.userId) ?? Number.NEGATIVE_INFINITY) >= newest.at) return null
  return newest
}

/** Users following `userId` (a user with two windows counts once). */
export function followerCount(peers: readonly PeerPresence[], userId: string | null): number {
  if (userId === null) return 0
  const users = new Set<string>()
  for (const p of peers) if (p.following === userId && p.userId !== userId) users.add(p.userId)
  return users.size
}

/** Ask everyone to follow this user. Starting a spotlight ends this user's own following. */
export function startSpotlight(store: EditorStore, now: number = Date.now()): void {
  store.setState({ spotlight: now, following: null, followSpotlight: null })
}

export function stopSpotlight(store: EditorStore): void {
  if (store.getState().spotlight !== null) store.setState({ spotlight: null })
}

export interface SpotlightDeps {
  /** This user's id (the welcome's, else the signed-in identity's). */
  selfUserId(): string | null
  /** A short status message (a toast in the editor). */
  notify(message: string): void
}

export class SpotlightController {
  private readonly handled = new Map<string, number>()

  constructor(
    private readonly store: EditorStore,
    private readonly deps: SpotlightDeps,
  ) {}

  detach(): void {
    this.handled.clear()
  }

  /** React to peers and to this user following someone else; returns the unsubscribe. */
  attach(): () => void {
    this.evaluate()
    return this.store.subscribe((s, prev) => {
      // This user started a spotlight: the ones running now are superseded.
      if (s.spotlight !== null && prev.spotlight === null) this.markRunning()
      // Broke away (or picked someone else): the spotlight no longer drives the follow.
      if (s.following !== prev.following && s.followSpotlight !== null) {
        if (s.following !== s.followSpotlight.userId) this.store.setState({ followSpotlight: null })
      }
      if (s.peers !== prev.peers) this.evaluate()
    })
  }

  private markRunning(): void {
    const s = this.store.getState()
    for (const p of activeSpotlights(s.peers, this.deps.selfUserId())) {
      if ((this.handled.get(p.userId) ?? Number.NEGATIVE_INFINITY) < p.at) {
        this.handled.set(p.userId, p.at)
      }
    }
  }

  private evaluate(): void {
    const s = this.store.getState()
    const self = this.deps.selfUserId()
    const active = activeSpotlights(s.peers, self)
    const followed = s.followSpotlight
    if (followed !== null && !active.some((p) => p.userId === followed.userId)) {
      // The spotlight that started this follow ended (or its presenter left).
      this.store.setState({
        followSpotlight: null,
        ...(s.following === followed.userId ? { following: null } : {}),
      })
      this.deps.notify(`${followed.name} stopped spotlighting`)
    }
    const state = this.store.getState()
    const next = nextSpotlight(state.peers, self, state.spotlight, this.handled)
    if (next === null) return
    this.markRunning()
    this.store.setState({ following: next.userId, followSpotlight: next, spotlight: null })
    this.deps.notify(`${next.name} is spotlighting — you're following them`)
  }
}
