/**
 * Agent presence on the overlay (Phase 4 contract §10.4, artboard 35): grouping per artboard,
 * joined names, top-level artboards of the current page only and no cursors.
 */
import { describe, expect, it } from 'vitest'
import {
  INCOMING_APPEAR_MS,
  INCOMING_FADE_MS,
  INCOMING_HOLD_MS,
  incomingPhase,
} from '../../src/overlay/incoming.ts'
import { agentBadgeText, agentWork, buildOverlayModel } from '../../src/overlay/model.ts'
import type { SceneManager } from '../../src/render/sceneManager.ts'
import type { RemotePresence, Rect } from '../../src/types.ts'

const agent = (
  name: string,
  selection: string[],
  extra: Partial<RemotePresence> = {},
): RemotePresence => ({
  userId: `agent-${name}`,
  name,
  color: '',
  pageId: null,
  cursor: { x: 10, y: 10 },
  selection,
  kind: 'agent',
  badge: name,
  ...extra,
})

const user = (name: string, selection: string[]): RemotePresence => ({
  userId: `user-${name}`,
  name,
  color: '#F04E1E',
  pageId: 'page',
  cursor: { x: 1, y: 2 },
  selection,
})

describe('agentBadgeText', () => {
  it('shows the names on the island ("A", "A & B", "A, B & C")', () => {
    expect(agentBadgeText(['Claude Code'])).toBe('Claude Code')
    expect(agentBadgeText(['Claude Code', 'Cursor'])).toBe('Claude Code & Cursor')
    expect(agentBadgeText(['A', 'B', 'C'])).toBe('A, B & C')
    expect(agentBadgeText([])).toBe('Agent')
  })
})

describe('agentWork', () => {
  const tops = new Set(['board-1', 'board-2'])
  const isTop = (id: string) => tops.has(id)

  it('groups agents per top-level artboard, each name once, in presence order', () => {
    const work = agentWork(
      [
        agent('Claude Code', ['board-1', 'board-2']),
        agent('Cursor', ['board-1']),
        // The same agent relayed by a collaborator (deduplicated by name per artboard).
        agent('Claude Code', ['board-1'], { userId: 'peer:agent' }),
      ],
      isTop,
    )
    expect([...work.entries()]).toEqual([
      ['board-1', ['Claude Code', 'Cursor']],
      ['board-2', ['Claude Code']],
    ])
  })

  it('ignores ids that are not top-level artboards on this page, and user entries', () => {
    const work = agentWork(
      [agent('Claude Code', ['nested-text', 'other-page-board']), user('Ana', ['board-1'])],
      isTop,
    )
    expect(work.size).toBe(0)
  })

  it('falls back to the presence name, then "Agent"', () => {
    const work = agentWork(
      [
        agent('', ['board-1'], { badge: undefined, name: 'Codex' }),
        agent('', ['board-2'], { badge: '  ', name: '' }),
      ],
      isTop,
    )
    expect(work.get('board-1')).toEqual(['Codex'])
    expect(work.get('board-2')).toEqual(['Agent'])
  })
})

/* A SceneManager stand-in with the members buildOverlayModel reads. */
function fakeScenes(boards: { id: string; type?: string; bounds: Rect; name?: string }[]) {
  const records = new Map(
    boards.map((b) => [
      b.id,
      {
        id: b.id,
        type: b.type ?? 'frame',
        name: b.name ?? b.id,
        bounds: b.bounds,
        componentKey: null,
        hidden: false,
      },
    ]),
  )
  return {
    records,
    visibleTops: () => [...records.values()],
    boundsOf: (id: string) => records.get(id)?.bounds ?? null,
    frameOf: (id: string) => {
      const r = records.get(id)?.bounds
      return r ? { ...r, rotation: 0 } : null
    },
    info: () => null,
  } as unknown as SceneManager
}

function model(remotes: RemotePresence[]) {
  const scenes = fakeScenes([
    { id: 'pricing', bounds: { x: 0, y: 0, width: 600, height: 454 }, name: 'Pricing — Desktop' },
    { id: 'mobile', bounds: { x: 700, y: 0, width: 375, height: 800 } },
    { id: 'logo', type: 'svg', bounds: { x: 0, y: 600, width: 40, height: 40 } },
  ])
  return buildOverlayModel({
    viewport: { x: -100, y: -100, zoom: 1, width: 1440, height: 900 },
    scenes,
    pageId: 'page',
    selection: [],
    hoverId: null,
    editingId: null,
    gesture: null,
    gestureOverlay: {
      marquee: null,
      guides: [],
      insertion: null,
      draft: null,
      draftLabel: null,
      drop: null,
      angle: null,
      pen: null,
    } as never,
    remotes,
    showHandles: false,
  })
}

describe('buildOverlayModel with agents', () => {
  it('draws one entry per working artboard with the joined badge, and labels leave room', () => {
    const m = model([agent('Claude Code', ['pricing', 'logo']), agent('Cursor', ['pricing'])])
    expect(m.agents).toEqual([
      {
        id: 'pricing',
        bounds: { x: 0, y: 0, width: 600, height: 454 },
        badge: 'Claude Code & Cursor',
      },
      // Top-level non-frames get the edge and badge too (no label).
      {
        id: 'logo',
        bounds: { x: 0, y: 600, width: 40, height: 40 },
        badge: 'Claude Code',
      },
    ])
    const pricing = m.labels.find((l) => l.id === 'pricing')
    expect(pricing?.badge).toBe('Claude Code & Cursor')
    expect(m.labels.find((l) => l.id === 'mobile')?.badge).toBeUndefined()
    expect(m.labels.some((l) => l.id === 'logo')).toBe(false)
  })

  it('never draws agents as collaborators (no cursor, no selection outline)', () => {
    const m = model([agent('Claude Code', ['pricing']), user('Ana', ['mobile'])])
    expect(m.remotes.map((r) => r.name)).toEqual(['Ana'])
  })

  it('draws nothing for agents without a working set on this page', () => {
    const m = model([agent('Claude Code', []), agent('Cursor', ['elsewhere'])])
    expect(m.agents).toEqual([])
    expect(m.labels.every((l) => l.badge === undefined)).toBe(true)
  })
})

describe('incomingPhase', () => {
  it('holds the placeholder with the layer hidden, then fades it while the layer shows', () => {
    expect(incomingPhase(0, false)).toEqual({ alpha: 0, shimmer: 0, hidden: true, done: false })
    expect(incomingPhase(INCOMING_APPEAR_MS, false).alpha).toBe(1)
    const mid = incomingPhase(INCOMING_HOLD_MS / 2, false)
    expect(mid.hidden).toBe(true)
    expect(mid.shimmer).toBeCloseTo(0.5)
    const fading = incomingPhase(INCOMING_HOLD_MS + INCOMING_FADE_MS / 2, false)
    expect(fading).toMatchObject({ hidden: false, shimmer: null, done: false })
    expect(fading.alpha).toBeCloseTo(0.5)
    expect(incomingPhase(INCOMING_HOLD_MS + INCOMING_FADE_MS, false).done).toBe(true)
  })

  it('never hides the layer and has no shimmer with reduced motion', () => {
    expect(incomingPhase(0, true)).toEqual({ alpha: 1, shimmer: null, hidden: false, done: false })
    expect(incomingPhase(INCOMING_FADE_MS / 2, true).alpha).toBeCloseTo(0.5)
    expect(incomingPhase(INCOMING_FADE_MS, true).done).toBe(true)
  })
})
