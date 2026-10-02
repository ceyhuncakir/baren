import type { PeerPresence } from '@baren/sync-client'
import { describe, expect, it, vi } from 'vitest'
import { PresenceRelay } from '../editor/collab/presence'
import {
  AgentPresenceStore,
  agentPresences,
  mergeAgents,
  peerAgents,
  toWireAgents,
  WIRE_LIMITS,
} from './presence'

function peer(clientId: string, name: string, agents?: unknown): PeerPresence {
  const p: Omit<PeerPresence, 'agents'> & { agents?: unknown } = {
    clientId,
    userId: `u-${clientId}`,
    name,
    color: '#f00',
    pageId: null,
    cursor: null,
    selection: [],
  }
  if (agents !== undefined) p.agents = agents
  return p as PeerPresence
}

describe('agent presence (contract §10.2)', () => {
  it('merges local and remote agents, local first, deduplicated', () => {
    const local = [{ id: 'a1', name: 'Claude Code', working: ['b1'], activeAt: 5 }]
    const peers = [
      peer('c1', 'Ana', [
        { id: 'x', name: 'Cursor', working: ['b2'] },
        { id: 'x', name: 'Cursor', working: ['b2'] },
      ]),
      peer('c2', 'Bob'),
    ]
    expect(mergeAgents(local, peers)).toEqual([
      { id: 'a1', name: 'Claude Code', working: ['b1'], activeAt: 5, origin: 'local', via: null },
      { id: 'c1:x', name: 'Cursor', working: ['b2'], activeAt: null, origin: 'remote', via: 'Ana' },
    ])
  })

  it('drops malformed remote agents and applies the wire limits', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, name: 'A', working: [] }))
    expect(peerAgents(peer('c', 'P', many))).toHaveLength(WIRE_LIMITS.agents)
    expect(peerAgents(peer('c', 'P', [{ id: 3, name: 'x' }, { name: 'no id' }, 'junk']))).toEqual(
      [],
    )
    expect(peerAgents(peer('c', 'P', 'nope'))).toEqual([])
    const wire = toWireAgents([
      {
        id: 'a',
        name: 'N'.repeat(100),
        working: Array.from({ length: 300 }, (_, i) => `w${i}`),
        activeAt: 1,
      },
    ])
    expect(wire[0]?.name).toHaveLength(WIRE_LIMITS.name)
    // Limits are bytes: multi-byte names are cut on a character boundary.
    const emoji = toWireAgents([{ id: 'b', name: '✦'.repeat(40), working: [], activeAt: 1 }])
    expect(new TextEncoder().encode(emoji[0]?.name).length).toBeLessThanOrEqual(WIRE_LIMITS.name)
    expect(emoji[0]?.name).toBe('✦'.repeat(21))
    expect(wire[0]?.working).toHaveLength(WIRE_LIMITS.working)
  })

  it('the store notifies only on real changes', () => {
    const store = new AgentPresenceStore()
    const cb = vi.fn()
    store.subscribe(cb)
    store.setLocal([{ id: 'a', name: 'A', working: ['b'], activeAt: 1 }])
    store.setLocal([{ id: 'a', name: 'A', working: ['b'], activeAt: 1 }])
    expect(cb).toHaveBeenCalledTimes(1)
    store.setRemote([peer('c', 'P', [{ id: 'z', name: 'Z', working: [] }])])
    expect(cb).toHaveBeenCalledTimes(2)
    expect(store.get().map((a) => a.id)).toEqual(['a', 'c:z'])
    store.setLocal([])
    expect(store.get().map((a) => a.id)).toEqual(['c:z'])
  })

  it('canvas entries are agent presences without cursor, the working set as selection', () => {
    expect(
      agentPresences([
        {
          id: 'a',
          name: 'Claude Code',
          working: ['b1', 'b2'],
          activeAt: 1,
          origin: 'local',
          via: null,
        },
      ]),
    ).toEqual([
      {
        userId: 'a',
        name: 'Claude Code',
        color: '',
        pageId: null,
        cursor: null,
        selection: ['b1', 'b2'],
        kind: 'agent',
        badge: 'Claude Code',
      },
    ])
  })

  it('PresenceRelay relays agents and re-sends them on attach', () => {
    const relay = new PresenceRelay()
    relay.setAgents([{ id: 'a', name: 'A', working: ['b'] }])
    const sent: Record<string, unknown>[] = []
    relay.attach({ setPresence: (p) => sent.push(p) })
    expect(sent[0]?.['agents']).toEqual([{ id: 'a', name: 'A', working: ['b'] }])
    relay.setAgents([{ id: 'a', name: 'A', working: ['b'] }])
    expect(sent).toHaveLength(1)
    relay.setAgents([])
    expect(sent[1]).toEqual({ agents: [] })
  })
})
