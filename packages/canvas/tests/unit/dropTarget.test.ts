import { describe, expect, it } from 'vitest'
import type { LoroDoc } from 'loro-crdt'
import type { Styles } from '@baren/schema'
import { DropTargetFinder } from '../../src/interaction/dropTarget.ts'
import type { IndexedNode } from '../../src/math/hit.ts'
import type { SceneManager } from '../../src/render/sceneManager.ts'
import type { Rect } from '../../src/types.ts'

interface FakeNode {
  id: string
  type: string
  parentId: string
  rect: Rect
  order: number
  depth: number
  locked?: boolean
  hidden?: boolean
  styles?: Styles
}

// page > board (0,0 400×300) > [frame A (absolute 20,20 200×200) > [frame B (40,40 100×100),
// rect R], group G (250,20 100×100) > rect GR]; board > instance I > virtual frame I/f
function fakeScenes(nodes: FakeNode[]): SceneManager {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const item = (n: FakeNode): IndexedNode => ({
    id: n.id,
    parentId: n.parentId,
    minX: n.rect.x,
    minY: n.rect.y,
    maxX: n.rect.x + n.rect.width,
    maxY: n.rect.y + n.rect.height,
    order: n.order,
    depth: n.depth,
    rect: n.rect,
  })
  const board = byId.get('board') as FakeNode
  const fake = {
    pageId: 'page',
    indexAt: (p: { x: number; y: number }) => [
      {
        rec: { id: 'board', type: 'frame', rotation: 0, bounds: board.rect, hidden: false },
        items: nodes
          .filter(
            (n) =>
              p.x >= n.rect.x &&
              p.x <= n.rect.x + n.rect.width &&
              p.y >= n.rect.y &&
              p.y <= n.rect.y + n.rect.height,
          )
          .map(item),
      },
    ],
    typeOf: (id: string) => byId.get(id)?.type ?? null,
    info: (id: string) => {
      const n = byId.get(id)
      if (!n) return null
      return {
        id,
        type: n.type,
        name: id,
        parentId: n.parentId,
        styles: n.styles ?? {},
        locked: n.locked === true,
        hidden: n.hidden === true,
        isTop: n.parentId === 'page',
        children: nodes.filter((c) => c.parentId === id).map((c) => c.id),
      }
    },
    frameOf: (id: string) => {
      const n = byId.get(id)
      return n ? { ...n.rect, rotation: 0 } : null
    },
    boundsOf: (id: string) => byId.get(id)?.rect ?? null,
  }
  return fake as unknown as SceneManager
}

const base: FakeNode[] = [
  {
    id: 'board',
    type: 'frame',
    parentId: 'page',
    rect: { x: 0, y: 0, width: 400, height: 300 },
    order: 0,
    depth: 0,
  },
  {
    id: 'A',
    type: 'frame',
    parentId: 'board',
    rect: { x: 20, y: 20, width: 200, height: 200 },
    order: 1,
    depth: 1,
  },
  {
    id: 'B',
    type: 'frame',
    parentId: 'A',
    rect: { x: 40, y: 40, width: 100, height: 100 },
    order: 2,
    depth: 2,
    styles: { display: 'flex', flexDirection: 'row' },
  },
  {
    id: 'R',
    type: 'rect',
    parentId: 'A',
    rect: { x: 150, y: 150, width: 40, height: 40 },
    order: 3,
    depth: 2,
  },
  {
    id: 'G',
    type: 'group',
    parentId: 'board',
    rect: { x: 250, y: 20, width: 100, height: 100 },
    order: 4,
    depth: 1,
  },
  {
    id: 'GR',
    type: 'rect',
    parentId: 'G',
    rect: { x: 260, y: 30, width: 20, height: 20 },
    order: 5,
    depth: 2,
  },
  {
    id: 'I',
    type: 'instance',
    parentId: 'board',
    rect: { x: 20, y: 230, width: 100, height: 60 },
    order: 6,
    depth: 1,
  },
  {
    id: 'I/f',
    type: 'frame',
    parentId: 'I',
    rect: { x: 25, y: 235, width: 50, height: 50 },
    order: 7,
    depth: 2,
  },
]
const doc = {} as LoroDoc

describe('drop-target choice (contract 5.2)', () => {
  it('picks the deepest eligible frame under the point', () => {
    const f = new DropTargetFinder(fakeScenes(base), doc)
    expect(f.at({ x: 50, y: 50 })?.id).toBe('B')
    expect(f.at({ x: 50, y: 50 })?.flex).toBe('row')
    expect(f.at({ x: 30, y: 180 })?.id).toBe('A')
    // Over a rect: the frame that contains it.
    expect(f.at({ x: 160, y: 160 })?.id).toBe('A')
  })

  it('never targets dragged nodes, their descendants, groups or instance content', () => {
    const exclude = new Set(['A'])
    const f = new DropTargetFinder(fakeScenes(base), doc, { exclude })
    expect(f.at({ x: 50, y: 50 })?.id).toBe('board')
    const g = new DropTargetFinder(fakeScenes(base), doc)
    expect(g.at({ x: 300, y: 80 })?.id).toBe('board')
    expect(g.at({ x: 30, y: 240 })?.id).toBe('board')
  })

  it('the dragged nodes’ own group counts as a candidate', () => {
    const f = new DropTargetFinder(fakeScenes(base), doc, {
      keepParent: 'G',
      exclude: new Set(['GR']),
    })
    expect(f.at({ x: 300, y: 80 })).toMatchObject({ id: 'G', type: 'group' })
  })

  it('skips locked or hidden frames (and their content) and rejected candidates', () => {
    const locked = base.map((n) => (n.id === 'A' ? { ...n, locked: true } : n))
    expect(new DropTargetFinder(fakeScenes(locked), doc).at({ x: 50, y: 50 })?.id).toBe('board')
    const accept = (id: string): boolean => id !== 'B'
    expect(new DropTargetFinder(fakeScenes(base), doc, { accept }).at({ x: 50, y: 50 })?.id).toBe(
      'A',
    )
  })

  it('with topOnly, only the artboard (files dropped without `deep`)', () => {
    expect(
      new DropTargetFinder(fakeScenes(base), doc, { topOnly: true }).at({ x: 50, y: 50 })?.id,
    ).toBe('board')
  })

  it('outside every frame: the page (null)', () => {
    expect(new DropTargetFinder(fakeScenes(base), doc).at({ x: 900, y: 900 })).toBeNull()
  })
})
