/**
 * Agents in an open file (contract §10.2): the local ones (main's `agent:presence` for this
 * file: agents connected to this app) and the remote ones (relayed by collaborators' presence
 * `agents` field), merged into `EditorState.agents`, and turned into canvas presence entries of
 * `kind: 'agent'` (ring, halo, glow and an island with their name on their working artboards).
 */
import type { RemotePresence } from '@baren/canvas'
import type { PeerPresence } from '@baren/sync-client'
import type { AgentPresence } from '../types/bridge'

export interface EditorAgent {
  /** Local: presenceId; remote: `${clientId}:${id}`. */
  id: string
  name: string
  /** Artboard ids. */
  working: string[]
  /** Local agents only (epoch ms of the last tool call on this file). */
  activeAt: number | null
  origin: 'local' | 'remote'
  /** Remote: the relaying user's display name. */
  via: string | null
}

/** What the live-sync presence frame carries per agent (contract §10.3; sync-client's type). */
export type AgentWirePresence = NonNullable<PeerPresence['agents']>[number]

/** Server limits (contract §10.3): ≤ 8 agents per client, id/name ≤ 64 bytes, ≤ 200 working ids ≤ 256 bytes. */
export const WIRE_LIMITS = { agents: 8, id: 64, name: 64, working: 200, workingId: 256 } as const

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
}

/** A peer's `agents` field, validated (unknown shapes are dropped). */
export function peerAgents(peer: PeerPresence): AgentWirePresence[] {
  const raw: unknown = peer.agents
  if (!Array.isArray(raw)) return []
  const out: AgentWirePresence[] = []
  for (const a of raw.slice(0, WIRE_LIMITS.agents)) {
    if (typeof a !== 'object' || a === null) continue
    const r = a as unknown as Record<string, unknown>
    const id = str(r['id'], WIRE_LIMITS.id)
    const name = str(r['name'], WIRE_LIMITS.name)
    if (id === null || name === null) continue
    const working = Array.isArray(r['working'])
      ? r['working']
          .filter((w): w is string => typeof w === 'string' && w.length <= WIRE_LIMITS.workingId)
          .slice(0, WIRE_LIMITS.working)
      : []
    out.push({ id, name, working })
  }
  return out
}

/** Truncate to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(text: string, max: number): string {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const n = enc.encode(ch).length
    if (used + n > max) break
    out += ch
    used += n
  }
  return out
}

/**
 * Local agents as relayed to collaborators, within the server's limits (bytes; a frame over
 * them is dropped as a whole).
 */
export function toWireAgents(local: readonly AgentPresence[]): AgentWirePresence[] {
  const enc = new TextEncoder()
  return local
    .filter((a) => enc.encode(a.id).length <= WIRE_LIMITS.id)
    .slice(0, WIRE_LIMITS.agents)
    .map((a) => ({
      id: a.id,
      name: truncateBytes(a.name, WIRE_LIMITS.name),
      working: a.working
        .filter((w) => enc.encode(w).length <= WIRE_LIMITS.workingId)
        .slice(0, WIRE_LIMITS.working),
    }))
}

/** Merge local and remote agents (local first, deduplicated by id). */
export function mergeAgents(
  local: readonly AgentPresence[],
  peers: readonly PeerPresence[],
): EditorAgent[] {
  const out: EditorAgent[] = []
  const seen = new Set<string>()
  for (const a of local) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    out.push({
      id: a.id,
      name: a.name,
      working: [...a.working],
      activeAt: a.activeAt,
      origin: 'local',
      via: null,
    })
  }
  for (const p of peers) {
    const client = p.clientId || p.userId
    for (const a of peerAgents(p)) {
      const id = `${client}:${a.id}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name: a.name,
        working: a.working,
        activeAt: null,
        origin: 'remote',
        via: p.name,
      })
    }
  }
  return out
}

function sameAgents(a: readonly EditorAgent[], b: readonly EditorAgent[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as EditorAgent
    const y = b[i] as EditorAgent
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.activeAt !== y.activeAt ||
      x.origin !== y.origin ||
      x.via !== y.via ||
      x.working.length !== y.working.length ||
      x.working.some((w, k) => w !== y.working[k])
    ) {
      return false
    }
  }
  return true
}

/** Per-session store of the agents in a file (`EditorSession.agents`). */
export class AgentPresenceStore {
  private local: readonly AgentPresence[] = []
  private peers: readonly PeerPresence[] = []
  private merged: readonly EditorAgent[] = []
  private readonly listeners = new Set<() => void>()

  setLocal(agents: readonly AgentPresence[]): void {
    this.local = agents.map((a) => ({ ...a, working: [...a.working] }))
    this.recompute()
  }

  setRemote(peers: readonly PeerPresence[]): void {
    this.peers = peers
    this.recompute()
  }

  /** Every agent (local first). */
  get(): readonly EditorAgent[] {
    return this.merged
  }

  /** Agents connected to this app (main's presence for this file). */
  getLocal(): readonly AgentPresence[] {
    return this.local
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  dispose(): void {
    this.listeners.clear()
    this.local = []
    this.peers = []
    this.merged = []
  }

  private recompute(): void {
    const next = mergeAgents(this.local, this.peers)
    if (sameAgents(next, this.merged)) return
    this.merged = next
    for (const l of [...this.listeners]) l()
  }
}

/** Canvas presence entries for agents (contract §10.2): no cursor, the working set as selection. */
export function agentPresences(agents: readonly EditorAgent[]): RemotePresence[] {
  return agents.map((a) => ({
    userId: a.id,
    name: a.name,
    color: '',
    pageId: null,
    cursor: null,
    selection: [...a.working],
    kind: 'agent' as const,
    badge: a.name,
  }))
}
