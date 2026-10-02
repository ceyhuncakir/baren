import {
  createEmptyDoc,
  createNode,
  getChildIds,
  loadDoc,
  exportSnapshot,
  toSnapshot,
} from '@baren/schema'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { seedFixture, fixtureView } from '../fixtures'
import { ARTBOARD_NAMES, COMPONENT_LIBRARY_PAGES, isPristine } from '../fixtures/componentLibrary'
import { Persistence } from './persistence'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('Persistence', () => {
  it('batches local edits into one update that rebuilds the doc', async () => {
    const stored = createEmptyDoc('file', { peerId: 1 })
    const base = exportSnapshot(stored)
    const doc = loadDoc(base)
    const saved: Uint8Array[] = []
    const p = new Persistence(doc, async (u) => void saved.push(u), doc.oplogVersion(), {
      debounceMs: 5,
    })
    const page = getChildIds(doc, null)[0] as string
    createNode(doc, { type: 'frame', parentId: page, name: 'A' })
    createNode(doc, { type: 'frame', parentId: page, name: 'B' })
    await tick(30)
    expect(saved).toHaveLength(1)
    const replay = loadDoc([base, ...saved])
    expect(toSnapshot(replay)).toEqual(toSnapshot(doc))
    expect(p.changed).toBe(true)
    await p.dispose()
  })

  it('also saves imported (remote) changes', async () => {
    const doc = createEmptyDoc('file', { peerId: 1 })
    const remote = new LoroDoc()
    remote.setPeerId(2)
    remote.import(doc.export({ mode: 'snapshot' }))
    const saved: Uint8Array[] = []
    const p = new Persistence(doc, async (u) => void saved.push(u), doc.oplogVersion(), {
      debounceMs: 1,
    })
    createNode(remote, {
      type: 'frame',
      parentId: getChildIds(remote, null)[0] as string,
      name: 'Remote',
    })
    doc.import(remote.export({ mode: 'update', from: doc.oplogVersion() }))
    await tick(20)
    expect(saved.length).toBeGreaterThan(0)
    await p.dispose()
  })

  it('keeps changes pending when a save fails and retries on flush', async () => {
    const doc = createEmptyDoc('file', { peerId: 1 })
    let fail = true
    const saved: Uint8Array[] = []
    const errors: unknown[] = []
    const p = new Persistence(
      doc,
      async (u) => {
        if (fail) throw new Error('disk full')
        saved.push(u)
      },
      doc.oplogVersion(),
      { debounceMs: 1, onError: (e) => errors.push(e) },
    )
    createNode(doc, { type: 'frame', parentId: getChildIds(doc, null)[0] as string, name: 'A' })
    await tick(10)
    expect(errors).toHaveLength(1)
    fail = false
    await p.flush()
    expect(saved).toHaveLength(1)
    await p.dispose()
  })
})

describe('design fixtures', () => {
  it('seeds the component library once and derives the overview viewport', () => {
    const doc = createEmptyDoc('baren')
    expect(isPristine(doc)).toBe(true)
    seedFixture(doc, 'f-acme', null)
    const snap = toSnapshot(doc)
    expect(snap.pageIds.map((id) => snap.nodes[id]?.name)).toEqual([...COMPONENT_LIBRARY_PAGES])
    const library = snap.pageIds[0] as string
    expect(snap.nodes[library]?.children.map((id) => snap.nodes[id]?.name)).toEqual([
      ...ARTBOARD_NAMES,
    ])
    const forms = snap.nodes[library]?.children[2] as string
    const sections = snap.nodes[forms]?.children.map((id) => snap.nodes[id]?.name)
    expect(sections).toEqual([
      'Header',
      'Section / Text input',
      'Section / Select',
      'Section / Checkbox & radio',
      'Footer',
    ])
    const view = fixtureView(doc, 'f-acme', null)
    expect(view?.pageId).toBe(library)
    expect(view?.viewports[library]?.zoom).toBeCloseTo(0.14)
    // A second seed is a no-op: the document is no longer pristine.
    const before = Object.keys(snap.nodes).length
    seedFixture(doc, 'f-acme', null)
    expect(Object.keys(toSnapshot(doc).nodes)).toHaveLength(before)
  })

  it('leaves other files empty unless a scene asks for content', () => {
    const doc = createEmptyDoc('Baren')
    seedFixture(doc, 'f-baren', null)
    expect(isPristine(doc)).toBe(true)
    seedFixture(doc, 'f-baren', 'theme')
    const snap = toSnapshot(doc)
    expect(Object.keys(snap.tokens)).toContain('--color-selection')
    const page = snap.pageIds[0] as string
    expect(snap.nodes[page]?.children.map((id) => snap.nodes[id]?.name)).toEqual(['Theme preview'])
  })
})
