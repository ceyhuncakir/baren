import type { PeerPresence } from '@baren/sync-client'
import { describe, expect, it } from 'vitest'
import { createEditorStore } from '../session/store'
import { PeerActivity } from './follow'
import { PresenceRelay } from './presence'
import {
  SpotlightController,
  activeSpotlights,
  followerCount,
  nextSpotlight,
  startSpotlight,
  stopSpotlight,
} from './spotlight'

function peer(
  over: Partial<PeerPresence> & Pick<PeerPresence, 'clientId' | 'userId'>,
): PeerPresence {
  return {
    name: over.userId === 'u2' ? 'Maya' : 'Ben',
    color: '#6D4AFF',
    pageId: 'p1',
    cursor: null,
    selection: [],
    ...over,
  }
}

describe('spotlight decisions', () => {
  it('lists other users’ spotlights newest first, one per user', () => {
    const peers = [
      peer({ clientId: 'a', userId: 'u2', spotlight: 10 }),
      peer({ clientId: 'b', userId: 'u2', spotlight: 30 }),
      peer({ clientId: 'c', userId: 'u3', spotlight: 20 }),
      peer({ clientId: 'd', userId: 'me', spotlight: 99 }),
      peer({ clientId: 'e', userId: 'u4', spotlight: null }),
    ]
    expect(activeSpotlights(peers, 'me').map((s) => [s.userId, s.at])).toEqual([
      ['u2', 30],
      ['u3', 20],
    ])
  })

  it('picks the newest spotlight, unless it is not newer than mine or was handled', () => {
    const peers = [
      peer({ clientId: 'a', userId: 'u2', spotlight: 30 }),
      peer({ clientId: 'b', userId: 'u3', spotlight: 20 }),
    ]
    expect(nextSpotlight(peers, 'me', null, new Map())?.userId).toBe('u2')
    expect(nextSpotlight(peers, 'me', 40, new Map())).toBeNull()
    expect(nextSpotlight(peers, 'me', 25, new Map())?.userId).toBe('u2')
    // Broke away from u2's spotlight: no fallback to the older one.
    expect(nextSpotlight(peers, 'me', null, new Map([['u2', 30]]))).toBeNull()
    // u2 restarted: a new spotlight.
    const restarted = [peer({ clientId: 'a', userId: 'u2', spotlight: 50 })]
    expect(nextSpotlight(restarted, 'me', null, new Map([['u2', 30]]))?.at).toBe(50)
  })

  it('counts followers once per user', () => {
    const peers = [
      peer({ clientId: 'a', userId: 'u2', following: 'me' }),
      peer({ clientId: 'b', userId: 'u2', following: 'me' }),
      peer({ clientId: 'c', userId: 'u3', following: 'me' }),
      peer({ clientId: 'd', userId: 'u4', following: 'u2' }),
      peer({ clientId: 'e', userId: 'me', following: 'me' }),
    ]
    expect(followerCount(peers, 'me')).toBe(2)
    expect(followerCount(peers, null)).toBe(0)
  })

  it('follows the spotlighting window of a user with several', () => {
    const activity = new PeerActivity()
    const presenting = peer({ clientId: 'a', userId: 'u2', spotlight: 5 })
    const idle = peer({ clientId: 'b', userId: 'u2' })
    activity.update([presenting], 1)
    activity.update([presenting, idle], 2) // the idle window changed last
    expect(activity.pick([presenting, idle], 'u2')?.clientId).toBe('a')
  })
})

describe('SpotlightController', () => {
  function setup() {
    const store = createEditorStore({ pageId: 'p1' })
    const notes: string[] = []
    const controller = new SpotlightController(store, {
      selfUserId: () => 'me',
      notify: (m) => notes.push(m),
    })
    const off = controller.attach()
    const peers = (...list: PeerPresence[]) => store.setState({ peers: list })
    return { store, notes, off, peers }
  }

  it('follows a new spotlight, stops when it ends, and says so', () => {
    const { store, notes, peers } = setup()
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: 10 }))
    expect(store.getState()).toMatchObject({
      following: 'u2',
      followSpotlight: { userId: 'u2', name: 'Maya', at: 10 },
    })
    expect(notes).toEqual(["Maya is spotlighting — you're following them"])
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: null }))
    expect(store.getState()).toMatchObject({ following: null, followSpotlight: null })
    expect(notes[1]).toBe('Maya stopped spotlighting')
  })

  it('is not pulled back after breaking away, but is by a restarted spotlight', () => {
    const { store, peers } = setup()
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: 10 }))
    store.setState({ following: null }) // panned away (Follow's stop rules)
    expect(store.getState().followSpotlight).toBeNull()
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: 10, cursor: { x: 1, y: 2 } }))
    expect(store.getState().following).toBeNull()
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: 20 }))
    expect(store.getState().following).toBe('u2')
  })

  it('the most recent presenter wins, including over this user', () => {
    const { store, notes, peers } = setup()
    startSpotlight(store, 15)
    expect(store.getState().spotlight).toBe(15)
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: 10 }))
    expect(store.getState()).toMatchObject({ spotlight: 15, following: null })
    peers(
      peer({ clientId: 'a', userId: 'u2', spotlight: 10 }),
      peer({ clientId: 'b', userId: 'u3', spotlight: 25 }),
    )
    expect(store.getState()).toMatchObject({ spotlight: null, following: 'u3' })
    expect(notes).toEqual(["Ben is spotlighting — you're following them"])
    // After breaking away, the older, superseded spotlight never pulls.
    store.setState({ following: null })
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: 10 }))
    expect(store.getState().following).toBeNull()
    expect(notes).toHaveLength(1)
  })

  it('a spotlight running when this user starts one does not pull after it stops', () => {
    const { store, peers } = setup()
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: 10 }))
    store.setState({ following: null }) // broke away
    peers(
      peer({ clientId: 'a', userId: 'u2', spotlight: 10 }),
      peer({ clientId: 'b', userId: 'u3', spotlight: 12 }),
    )
    // u3 pulled this user; break away and present instead.
    store.setState({ following: null })
    startSpotlight(store, 30)
    stopSpotlight(store)
    peers(
      peer({ clientId: 'a', userId: 'u2', spotlight: 10 }),
      peer({ clientId: 'b', userId: 'u3', spotlight: 12, cursor: { x: 0, y: 0 } }),
    )
    expect(store.getState().following).toBeNull()
  })

  it('starting a spotlight ends following; stopping clears it', () => {
    const { store } = setup()
    store.setState({ following: 'u2' })
    startSpotlight(store, 5)
    expect(store.getState()).toMatchObject({ following: null, spotlight: 5 })
    stopSpotlight(store)
    expect(store.getState().spotlight).toBeNull()
  })

  it('does nothing after detach', () => {
    const { store, off, peers } = setup()
    off()
    peers(peer({ clientId: 'a', userId: 'u2', spotlight: 10 }))
    expect(store.getState().following).toBeNull()
  })
})

describe('PresenceRelay spotlight fields', () => {
  it('relays spotlight and following and re-sends them on attach', () => {
    const relay = new PresenceRelay()
    const sent: Record<string, unknown>[] = []
    relay.setSpotlight(42)
    relay.setFollowing('u2')
    relay.attach({ setPresence: (p) => sent.push(p) })
    expect(sent[0]).toMatchObject({ spotlight: 42, following: 'u2' })
    relay.setSpotlight(42) // unchanged: not re-sent
    relay.setSpotlight(null)
    relay.setFollowing(null)
    expect(sent.slice(1)).toEqual([{ spotlight: null }, { following: null }])
    // A page change keeps them.
    relay.setFollowing('u3')
    relay.setPage('p2')
    relay.attach({ setPresence: (p) => sent.push(p) })
    expect(sent.at(-1)).toMatchObject({ pageId: 'p2', following: 'u3', spotlight: null })
  })
})
