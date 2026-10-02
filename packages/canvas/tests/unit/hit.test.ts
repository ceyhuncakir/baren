import RBush from 'rbush'
import { describe, expect, it } from 'vitest'
import {
  comparePaths,
  pathFromTop,
  pointBox,
  topmostAt,
  type IndexedNode,
} from '../../src/math/hit.ts'

function item(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  order: number,
  depth: number,
  parentId: string | null = null,
): IndexedNode {
  return {
    id,
    parentId,
    minX: x,
    minY: y,
    maxX: x + w,
    maxY: y + h,
    order,
    depth,
    rect: { x, y, width: w, height: h },
  }
}

describe('hit testing', () => {
  const items = [
    item('artboard', 0, 0, 400, 300, 0, 0),
    item('section', 20, 20, 200, 100, 1, 1, 'artboard'),
    item('text', 30, 30, 50, 20, 2, 2, 'section'),
    item('floating', 25, 25, 100, 100, 3, 1, 'artboard'),
  ]
  const tree = new RBush<IndexedNode>().load(items)

  it('returns the top-most node in paint order', () => {
    const p = { x: 35, y: 35 }
    expect(topmostAt(tree.search(pointBox(p)), p)?.id).toBe('floating')
  })

  it('falls back to lower nodes outside the top one', () => {
    const p = { x: 210, y: 110 }
    expect(topmostAt(tree.search(pointBox(p)), p)?.id).toBe('section')
    const q = { x: 390, y: 290 }
    expect(topmostAt(tree.search(pointBox(q)), q)?.id).toBe('artboard')
    expect(topmostAt(tree.search(pointBox({ x: 500, y: 0 })), { x: 500, y: 0 })).toBeNull()
  })

  it('honours an accept filter (e.g. skip dragged nodes)', () => {
    const p = { x: 35, y: 35 }
    expect(topmostAt(tree.search(pointBox(p)), p, (n) => n.id !== 'floating')?.id).toBe('text')
  })

  it('compares sibling-index paths in paint order', () => {
    expect(comparePaths([0, 1], [0, 2])).toBeLessThan(0)
    expect(comparePaths([0, 2], [0, 1, 5])).toBeGreaterThan(0)
    expect(comparePaths([0, 1], [0, 1, 0])).toBeLessThan(0)
    expect(comparePaths([3], [3])).toBe(0)
  })

  it('builds the path from the top-level node', () => {
    const parents: Record<string, string | null> = {
      page: null,
      a: 'page',
      b: 'a',
      c: 'b',
      other: 'page2',
      page2: null,
    }
    const parentOf = (id: string): string | null => parents[id] ?? null
    expect(pathFromTop('c', parentOf, 'page')).toEqual(['a', 'b', 'c'])
    expect(pathFromTop('a', parentOf, 'page')).toEqual(['a'])
    expect(pathFromTop('other', parentOf, 'page')).toEqual([])
  })
})
