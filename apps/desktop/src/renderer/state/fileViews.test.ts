import { describe, expect, it } from 'vitest'
import type { FileMeta } from '../types/bridge'
import {
  findScratchpad,
  gridColumns,
  orderByRecency,
  selectView,
  touchRecent,
  MAX_RECENTS,
} from './fileViews'

const file = (id: string, over: Partial<FileMeta> = {}): FileMeta => ({
  id,
  name: id,
  createdAt: 0,
  updatedAt: 0,
  archived: false,
  teamId: null,
  remoteId: null,
  ...over,
})

describe('file views', () => {
  it('orders recents by last opened, then by edit time', () => {
    const files = [
      file('a', { updatedAt: 5 }),
      file('b', { updatedAt: 9 }),
      file('c', { updatedAt: 1 }),
      file('d', { updatedAt: 7 }),
    ]
    expect(orderByRecency(files, ['c', 'a']).map((f) => f.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('keeps the MRU list unique and bounded', () => {
    expect(touchRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    const long = Array.from({ length: MAX_RECENTS }, (_, i) => `f${i}`)
    expect(touchRecent(long, 'new')).toHaveLength(MAX_RECENTS)
  })

  it('finds the scratchpad by remembered id, else the oldest "Scratchpad"', () => {
    const files = [
      file('x', { name: 'Scratchpad', createdAt: 5 }),
      file('y', { name: 'Scratchpad', createdAt: 2 }),
    ]
    expect(findScratchpad(files, null)?.id).toBe('y')
    expect(findScratchpad(files, 'x')?.id).toBe('x')
    expect(findScratchpad([file('z', { name: 'Scratchpad', archived: true })], null)).toBeNull()
  })

  it('pins the scratchpad in Recents and Files, and filters by search', () => {
    const files = [
      file('pad', { name: 'Scratchpad' }),
      file('logo', { updatedAt: 3 }),
      file('cv', { updatedAt: 9 }),
      file('old', { archived: true }),
    ]
    const recents = selectView(files, 'recents', { mru: ['logo'], scratchpadId: 'pad', query: '' })
    expect(recents.scratchpad).toMatchObject({ id: 'pad' })
    expect(recents.items.map((f) => f.id)).toEqual(['logo', 'cv'])
    const filesView = selectView(files, 'files', { mru: ['logo'], scratchpadId: 'pad', query: '' })
    expect(filesView.items.map((f) => f.id)).toEqual(['cv', 'logo'])
    const search = selectView(files, 'recents', { mru: [], scratchpadId: 'pad', query: 'LO' })
    expect(search.scratchpad).toBeNull()
    expect(search.items.map((f) => f.id)).toEqual(['logo'])
    const archive = selectView(files, 'archive', { mru: [], scratchpadId: 'pad', query: '' })
    expect(archive).toEqual({ scratchpad: null, items: [files[3]] })
  })

  it('reports a missing scratchpad so the card can create it', () => {
    expect(selectView([], 'recents', { mru: [], scratchpadId: null, query: '' }).scratchpad).toBe(
      'missing',
    )
  })

  it('fits 4 columns in the 1088px content width of artboard 01', () => {
    expect(gridColumns(1088)).toBe(4)
    expect(gridColumns(1300)).toBe(5)
    expect(gridColumns(200)).toBe(1)
    expect(gridColumns(0)).toBe(1)
  })
})
