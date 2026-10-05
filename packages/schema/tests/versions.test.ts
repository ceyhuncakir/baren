import { UndoManager } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  MAX_AUTO_VERSIONS,
  SchemaError,
  changedSinceVersion,
  createCommentThread,
  createNode,
  createVersion,
  deleteNode,
  deleteVersion,
  docAtVersion,
  getChildIds,
  getCommentThreads,
  getDocName,
  getNode,
  getTokens,
  getVersion,
  getVersions,
  renameVersion,
  restoreVersion,
  setDocName,
  setStyles,
  setTokens,
  subscribeNodes,
  transact,
  type CommentAuthor,
  type NodeChangeBatch,
} from '../src/index.ts'
import { docWithPage, flushEvents, sync, twoPeers } from './helpers.ts'

const ana: CommentAuthor = { id: 'u1', name: 'Ana', kind: 'user' }
const agent: CommentAuthor = { id: 'agent:Claude Code', name: 'Claude Code', kind: 'agent' }

const names = (doc: Parameters<typeof getChildIds>[0], pageId: string) =>
  getChildIds(doc, pageId).map((id) => getNode(doc, id)?.name)

describe('versions', () => {
  it('creates, lists newest first, renames and deletes', () => {
    const { doc } = docWithPage()
    const a = createVersion(doc, { name: '  First draft ', author: ana, now: 10 })
    const b = createVersion(doc, { name: '', author: agent, auto: true, reason: 'agent', now: 20 })
    expect(getVersions(doc).map((v) => [v.id, v.name, v.auto, v.reason, v.author.kind])).toEqual([
      [b, '', true, 'agent', 'agent'],
      [a, 'First draft', false, 'manual', 'user'],
    ])
    expect(getVersion(doc, a)?.createdAt).toBe(10)
    renameVersion(doc, b, 'Before the agent')
    expect(getVersion(doc, b)).toMatchObject({ name: 'Before the agent', auto: false })
    deleteVersion(doc, a)
    expect(getVersions(doc).map((v) => v.id)).toEqual([b])
    deleteVersion(doc, a) // already gone: no-op
  })

  it('rejects unnamed manual versions and unknown ids', () => {
    const { doc } = docWithPage()
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error instanceof SchemaError ? error.code : 'other'
      }
      return null
    }
    expect(code(() => createVersion(doc, { name: ' ', author: ana }))).toBe('invalid-version')
    expect(code(() => createVersion(doc, { name: 'x'.repeat(201), author: ana }))).toBe(
      'invalid-version',
    )
    expect(code(() => renameVersion(doc, 'nope', 'x'))).toBe('version-not-found')
  })

  it('shows the doc as it was in a fork, leaving the live doc alone', () => {
    const { doc, pageId } = docWithPage()
    createNode(doc, { type: 'frame', parentId: pageId, name: 'Hero' })
    const v = getVersion(doc, createVersion(doc, { name: 'One frame', author: ana }))!
    createNode(doc, { type: 'frame', parentId: pageId, name: 'Footer' })
    const past = docAtVersion(doc, v)
    expect(names(past, pageId)).toEqual(['Hero'])
    createNode(past, { type: 'frame', parentId: pageId, name: 'Scratch' })
    expect(names(doc, pageId)).toEqual(['Hero', 'Footer'])
  })

  it('restores the design as one undoable change, keeping comments and versions', () => {
    const { doc, pageId } = docWithPage('Original')
    const hero = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Hero',
      styles: { width: 400 },
    })
    const card = createNode(doc, { type: 'frame', parentId: pageId, name: 'Card' })
    setTokens(doc, { '--color-ink': { type: 'color', value: '#111111' } })
    const v = getVersion(doc, createVersion(doc, { name: 'Good state', author: ana }))!

    const undo = new UndoManager(doc, { excludeOriginPrefixes: ['version', 'comment'] })
    transact(doc, () => setStyles(doc, hero, { width: 900 }), { origin: 'editor:inspector' })
    transact(doc, () => deleteNode(doc, card), { origin: 'canvas:delete' })
    transact(doc, () => createNode(doc, { type: 'frame', parentId: pageId, name: 'Extra' }), {
      origin: 'canvas:create',
    })
    transact(doc, () => setTokens(doc, { '--color-ink': { type: 'color', value: '#FF0000' } }), {
      origin: 'editor:theme',
    })
    transact(doc, () => setDocName(doc, 'Renamed'), { origin: 'editor:rename' })
    const thread = transact(
      doc,
      () =>
        createCommentThread(doc, {
          pageId,
          nodeId: hero,
          x: 0,
          y: 0,
          worldX: 0,
          worldY: 0,
          author: ana,
          body: 'Made after the version',
        }),
      { origin: 'comment:create' },
    )
    const later = transact(doc, () => createVersion(doc, { name: 'Later', author: ana }), {
      origin: 'version:save',
    })
    expect(changedSinceVersion(doc, v)).toBe(true)

    expect(transact(doc, () => restoreVersion(doc, v), { origin: 'editor:restore' })).toBe(true)
    expect(getNode(doc, hero)?.styles['width']).toBe(400)
    expect(names(doc, pageId)).toEqual(['Hero', 'Card'])
    expect(getTokens(doc)['--color-ink']?.value).toBe('#111111')
    expect(getDocName(doc)).toBe('Original')
    // Card came back under a new id (Loro re-creates deleted tree nodes), so the design is
    // equivalent rather than identical: changedSinceVersion does not promise false here.
    // Comments and versions stay as they are now.
    expect(getCommentThreads(doc).map((t) => t.id)).toEqual([thread])
    expect(getVersions(doc).map((v) => v.id)).toContain(later)

    // One undo step brings the restored-over state back.
    undo.undo()
    expect(getNode(doc, hero)?.styles['width']).toBe(900)
    expect(names(doc, pageId)).toEqual(['Hero', 'Extra'])
    expect(getTokens(doc)['--color-ink']?.value).toBe('#FF0000')
    expect(getCommentThreads(doc)).toHaveLength(1)
  })

  it('knows when only comments or versions changed', () => {
    const { doc, pageId } = docWithPage()
    const v = getVersion(doc, createVersion(doc, { name: 'Start', author: ana }))!
    expect(changedSinceVersion(doc, v)).toBe(false)
    createCommentThread(doc, {
      pageId,
      nodeId: null,
      x: 0,
      y: 0,
      worldX: 0,
      worldY: 0,
      author: ana,
      body: 'Not a design change',
    })
    createVersion(doc, { name: 'Another', author: ana })
    expect(changedSinceVersion(doc, v)).toBe(false)
    expect(restoreVersion(doc, v)).toBe(false)
    createNode(doc, { type: 'frame', parentId: pageId, name: 'New' })
    expect(changedSinceVersion(doc, v)).toBe(true)
  })

  it('converges when a restore meets a concurrent edit from another peer', () => {
    const { a, b, pageId } = twoPeers()
    const hero = createNode(a, {
      type: 'frame',
      parentId: pageId,
      name: 'Hero',
      styles: { width: 1 },
    })
    const v = getVersion(a, createVersion(a, { name: 'v1', author: ana }))!
    setStyles(a, hero, { width: 2 })
    createNode(a, { type: 'frame', parentId: pageId, name: 'Temp' })
    sync(a, b)
    // A restores while B, offline, adds a frame.
    restoreVersion(a, v)
    createNode(b, { type: 'frame', parentId: pageId, name: 'From B' })
    sync(a, b)
    expect(a.toJSON()).toEqual(b.toJSON())
    expect(getNode(a, hero)?.styles['width']).toBe(1)
    expect(names(a, pageId)).toEqual(['Hero', 'From B'])
  })

  it('keeps the newest automatic checkpoints and every named version', () => {
    const { doc } = docWithPage()
    const named = createVersion(doc, { name: 'Keep me', author: ana, now: 0 })
    for (let i = 1; i <= MAX_AUTO_VERSIONS + 5; i++) {
      createVersion(doc, { name: '', author: ana, auto: true, now: i })
    }
    const all = getVersions(doc)
    expect(all.filter((v) => v.auto)).toHaveLength(MAX_AUTO_VERSIONS)
    expect(all.filter((v) => v.auto).at(-1)?.createdAt).toBe(6)
    expect(all.map((v) => v.id)).toContain(named)
  })

  it('reports changed versions in change batches', async () => {
    const { doc } = docWithPage()
    const batches: NodeChangeBatch[] = []
    subscribeNodes(doc, (b) => batches.push(b))
    const id = transact(doc, () => createVersion(doc, { name: 'v', author: ana }), {
      origin: 'version:save',
    })
    await flushEvents()
    expect(batches.map((b) => [b.versions, b.origin])).toEqual([[[id], 'version:save']])
  })
})
