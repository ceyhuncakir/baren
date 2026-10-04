/**
 * Stable presence callbacks for the canvas (cursor, selection, in-progress gestures).
 * Before a live connection exists they go nowhere; `attach` routes them to the
 * sync-client connection (which throttles to 30 Hz itself).
 */
import type { Point, RemotePresence, TransientChange } from '@baren/canvas'
import type { PeerPresence, ViewportPresence } from '@baren/sync-client'
import type { AgentWirePresence } from '../../agent/presence'

export { agentPresences } from '../../agent/presence'

export interface PresenceSink {
  setPresence(p: Record<string, unknown>): void
}

export class PresenceRelay {
  private sink: PresenceSink | null = null
  private state: {
    pageId: string | null
    cursor: Point | null
    selection: string[]
    viewport: ViewportPresence | null
  } = {
    pageId: null,
    cursor: null,
    selection: [],
    viewport: null,
  }
  /** MCP agents connected to this app, relayed to collaborators (Phase 4 contract §10.3). */
  private agents: AgentWirePresence[] = []

  attach(sink: PresenceSink | null): void {
    this.sink = sink
    if (sink) {
      sink.setPresence(
        this.agents.length > 0 ? { ...this.state, agents: this.agents } : { ...this.state },
      )
    }
  }

  readonly setPage = (pageId: string | null): void => {
    this.state.pageId = pageId
    this.sink?.setPresence({ pageId, selection: [], cursor: null })
  }

  readonly setCursor = (cursor: Point | null): void => {
    this.state.cursor = cursor
    this.sink?.setPresence({ cursor })
  }

  readonly setSelection = (selection: string[]): void => {
    this.state.selection = selection
    this.sink?.setPresence({ selection })
  }

  /** The world rectangle this canvas shows, so collaborators can follow it (`collab/follow`). */
  readonly setViewport = (viewport: ViewportPresence | null): void => {
    this.state.viewport = viewport
    this.sink?.setPresence({ viewport })
  }

  /**
   * In-progress move/resize ghosts, sent as the presence `transient` field (validated and
   * relayed by the server, never persisted).
   */
  readonly setTransient = (transient: TransientChange | null): void => {
    this.sink?.setPresence({ transient })
  }

  /**
   * Local agents (the optional presence `agents` field; old servers drop it). Remembered like
   * page and selection and re-sent on `attach`.
   */
  readonly setAgents = (agents: AgentWirePresence[]): void => {
    if (sameWire(this.agents, agents)) return
    this.agents = agents
    this.sink?.setPresence({ agents })
  }
}

function sameWire(a: readonly AgentWirePresence[], b: readonly AgentWirePresence[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i] as AgentWirePresence
    return (
      x.id === y.id &&
      x.name === y.name &&
      x.working.length === y.working.length &&
      x.working.every((w, k) => w === y.working[k])
    )
  })
}

/** Server presence → canvas presence (one entry per connected window). */
export function toRemotePresence(peers: readonly PeerPresence[]): RemotePresence[] {
  return peers.map((p) => {
    const transient: unknown = p.transient
    const out: RemotePresence = {
      userId: p.clientId || p.userId,
      name: p.name,
      color: p.color,
      pageId: p.pageId,
      cursor: p.cursor,
      selection: p.selection,
    }
    if (isTransient(transient)) out.transient = transient
    return out
  })
}

function isTransient(v: unknown): v is TransientChange {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Partial<TransientChange>
  return (t.kind === 'move' || t.kind === 'resize') && Array.isArray(t.nodes)
}

/** One avatar per user (a user with two windows open is one collaborator). */
export function uniquePeers(
  peers: readonly PeerPresence[],
  selfUserId: string | null,
): PeerPresence[] {
  const seen = new Set<string>()
  const out: PeerPresence[] = []
  for (const p of peers) {
    if (p.userId === selfUserId || seen.has(p.userId)) continue
    seen.add(p.userId)
    out.push(p)
  }
  return out
}
