/**
 * Follow a collaborator: clicking a teammate's avatar shows the page they are on and keeps
 * their visible world rectangle (presence `viewport`) centred and whole in this canvas.
 *
 * `EditorState.following` holds the followed user id; everything else lives here. A user with
 * several windows is followed through the window whose presence changed last. Following stops
 * when this user pans, zooms, clicks the canvas, presses Escape or picks another page, and when
 * the followed user leaves.
 */
import { fitRect, type CanvasController, type Viewport } from '@baren/canvas'
import type { PeerPresence, ViewportPresence } from '@baren/sync-client'
import type { EditorStore } from '../session/store'

/** The world rectangle a viewport shows (sent to collaborators as presence `viewport`). */
export function visibleWorldRect(v: Viewport): ViewportPresence {
  const zoom = v.zoom > 0 ? v.zoom : 1
  return { x: v.x, y: v.y, width: v.width / zoom, height: v.height / zoom }
}

/** The camera that shows `rect` centred and whole in a `width`×`height` canvas. */
export function cameraFor(
  rect: ViewportPresence,
  width: number,
  height: number,
): Pick<Viewport, 'x' | 'y' | 'zoom'> {
  const { x, y, zoom } = fitRect(rect, width, height, 0)
  return { x, y, zoom }
}

const EPSILON = 1e-6

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b))
}

/** Same camera position and zoom, within float noise (size is not compared). */
export function sameCamera(
  a: Pick<Viewport, 'x' | 'y' | 'zoom'>,
  b: Pick<Viewport, 'x' | 'y' | 'zoom'>,
): boolean {
  return near(a.x, b.x) && near(a.y, b.y) && near(a.zoom, b.zoom)
}

/** When each client's presence last changed (the sync client sends a new object per frame). */
export class PeerActivity {
  private seen = new Map<string, { peer: PeerPresence; at: number }>()

  update(peers: readonly PeerPresence[], now: number): void {
    const next = new Map<string, { peer: PeerPresence; at: number }>()
    for (const peer of peers) {
      const before = this.seen.get(peer.clientId)
      next.set(peer.clientId, { peer, at: before && before.peer === peer ? before.at : now })
    }
    this.seen = next
  }

  /**
   * The client of `userId` to follow: the one that changed most recently, among the windows
   * that are spotlighting when any is (`collab/spotlight`).
   */
  pick(peers: readonly PeerPresence[], userId: string): PeerPresence | null {
    const spotlighting = peers.some((p) => p.userId === userId && typeof p.spotlight === 'number')
    let best: PeerPresence | null = null
    let bestAt = Number.NEGATIVE_INFINITY
    for (const peer of peers) {
      if (peer.userId !== userId) continue
      if (spotlighting && typeof peer.spotlight !== 'number') continue
      const at = this.seen.get(peer.clientId)?.at ?? Number.NEGATIVE_INFINITY
      if (best === null || at >= bestAt) {
        best = peer
        bestAt = at
      }
    }
    return best
  }
}

export interface FollowDeps {
  canvas(): CanvasController | null
  /** The page exists in this document (it may not have synced yet). */
  hasPage(pageId: string): boolean
  now?(): number
}

export class FollowController {
  /** The camera this controller last set: any other camera means the user moved. */
  private applied: Viewport | null = null
  /** A page this controller switched to that the canvas does not show yet. */
  private pendingPage: string | null = null
  /**
   * True while this controller moves the camera: the canvas reports that move synchronously
   * (its throttle emits on the leading edge), before `applied` holds the new camera.
   */
  private applying = false
  private readonly activity = new PeerActivity()

  constructor(
    private readonly store: EditorStore,
    private readonly deps: FollowDeps,
  ) {
    this.activity.update(store.getState().peers, this.now())
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** React to `following`, peers and page changes; returns the unsubscribe. */
  attach(): () => void {
    return this.store.subscribe((s, prev) => {
      if (s.peers !== prev.peers) this.activity.update(s.peers, this.now())
      if (s.following !== prev.following) {
        this.applied = null
        this.pendingPage = null
        if (s.following !== null) this.sync()
        return
      }
      if (s.following === null) return
      if (s.pageId !== prev.pageId && s.pageId !== this.pendingPage) {
        // This user picked another page.
        this.stop()
        return
      }
      if (s.peers !== prev.peers) this.sync()
    })
  }

  stop(): void {
    if (this.store.getState().following !== null) this.store.setState({ following: null })
  }

  /** The canvas shows the store's page now (CanvasArea, after its page effects). */
  onCanvasPage(): void {
    const canvas = this.deps.canvas()
    if (this.pendingPage === null || canvas?.getPageId() !== this.pendingPage) return
    this.pendingPage = null
    this.sync()
  }

  /** The canvas camera moved or resized. */
  onViewport(v: Viewport): void {
    if (this.applying) return
    if (this.store.getState().following === null || this.pendingPage !== null) return
    const applied = this.applied
    if (applied === null) return
    if (!sameCamera(v, applied)) {
      this.stop()
      return
    }
    // Resized (panels, window): centre the followed rectangle again.
    if (v.width !== applied.width || v.height !== applied.height) this.sync()
  }

  private sync(): void {
    const s = this.store.getState()
    if (s.following === null) return
    const peer = this.activity.pick(s.peers, s.following)
    if (peer === null) {
      this.stop()
      return
    }
    if (peer.pageId !== null && peer.pageId !== s.pageId) {
      if (!this.deps.hasPage(peer.pageId)) return
      this.pendingPage = peer.pageId
      this.store.setState({ pageId: peer.pageId, selection: [], hoveredId: null })
      this.onCanvasPage()
      return
    }
    if (this.pendingPage !== null) return
    const canvas = this.deps.canvas()
    if (!canvas || canvas.getPageId() !== s.pageId) return
    const current = canvas.getViewport()
    const rect = peer.viewport
    if (rect) {
      const target = cameraFor(rect, current.width, current.height)
      if (!sameCamera(target, current)) {
        this.applying = true
        try {
          canvas.setViewport(target, { animate: false })
        } finally {
          this.applying = false
        }
      }
    }
    this.applied = canvas.getViewport()
  }
}
