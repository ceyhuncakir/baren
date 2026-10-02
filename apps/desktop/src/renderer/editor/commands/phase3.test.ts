/**
 * Phase 3 editor commands against real Loro documents (no canvas): group / ungroup, create
 * component, instances and overrides, reset, detach, and the clipboard through the mock
 * bridge — within one file and across files (tokens, components and image bytes carried).
 */
import {
  createEmptyDoc,
  createNode,
  getChildIds,
  getNode,
  getTokens,
  listComponents,
  setTextAt,
  setTokens,
  toSnapshot,
  virtualId,
  type DesignNode,
} from '@baren/schema'
import { UndoManager, type LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'
import { bridge } from '../../lib/bridge'
import { LayerTree } from '../model/layerTree'
import type { EditorSession } from '../session/context'
import { ComponentsWatcher, DocEvents, TokensWatcher } from '../session/docEvents'
import { createEditorStore } from '../session/store'
import { EditorActions } from './actions'
import { editorKeyAction } from './keymap'

const UNDO_EXCLUDE = ['remote', 'sync', 'bench', 'fixture', 'preview', 'derived']

interface Harness {
  doc: LoroDoc
  page: string
  session: EditorSession
  actions: EditorActions
  /** Undo history from here on (setup commits before this are not undoable). */
  startUndo(): UndoManager
  select(ids: string[]): void
  dispose(): void
}

const open: Harness[] = []

function harness(fileId: string, peer: number): Harness {
  const doc = createEmptyDoc(fileId, { peerId: peer })
  const page = getChildIds(doc, null)[0] as string
  const events = new DocEvents(doc)
  const tree = new LayerTree(doc, events.resolver)
  events.subscribe((b, a) => tree.apply(b, a))
  const store = createEditorStore({ pageId: page })
  let session: EditorSession
  const actions = new EditorActions(() => session)
  session = {
    fileId,
    doc,
    events,
    resolver: events.resolver,
    tree,
    components: new ComponentsWatcher(events),
    tokens: new TokensWatcher(events),
    store,
    canvas: { current: null },
    canvasEl: { current: null },
    actions,
    file: null,
  } as unknown as EditorSession
  const h: Harness = {
    doc,
    page,
    session,
    actions,
    startUndo: () =>
      new UndoManager(doc, { mergeInterval: 0, excludeOriginPrefixes: UNDO_EXCLUDE }),
    select: (ids) => store.setState({ selection: ids }),
    dispose: () => events.dispose(),
  }
  open.push(h)
  return h
}

afterEach(() => {
  for (const h of open.splice(0)) h.dispose()
})

function node(doc: LoroDoc, id: string): DesignNode {
  const n = getNode(doc, id)
  if (!n) throw new Error(`missing ${id}`)
  return n
}

/** A page-level artboard with two absolutely positioned rectangles. */
function board(h: Harness) {
  const art = createNode(h.doc, {
    type: 'frame',
    parentId: h.page,
    name: 'Board',
    styles: { left: 0, top: 0, width: 400, height: 300, backgroundColor: '#FFFFFF' },
  })
  const a = createNode(h.doc, {
    type: 'rect',
    parentId: art,
    name: 'A',
    styles: { position: 'absolute', left: 10, top: 20, width: 50, height: 40 },
  })
  const b = createNode(h.doc, {
    type: 'rect',
    parentId: art,
    name: 'B',
    styles: { position: 'absolute', left: 100, top: 120, width: 30, height: 30 },
  })
  return { art, a, b }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('Phase 3 shortcuts', () => {
  const key = (k: string, code: string, mods: Partial<Record<'ctrl' | 'shift' | 'alt', boolean>>) =>
    editorKeyAction(
      {
        key: k,
        code,
        ctrlKey: mods.ctrl ?? false,
        metaKey: false,
        shiftKey: mods.shift ?? false,
        altKey: mods.alt ?? false,
      },
      'linux',
    )

  it('maps group, ungroup, component, detach, paste in place, pen and the picker', () => {
    expect(key('g', 'KeyG', { ctrl: true })).toEqual({ kind: 'group' })
    expect(key('G', 'KeyG', { ctrl: true, shift: true })).toEqual({ kind: 'ungroup' })
    expect(key('k', 'KeyK', { ctrl: true, alt: true })).toEqual({ kind: 'createComponent' })
    expect(key('b', 'KeyB', { ctrl: true, alt: true })).toEqual({ kind: 'detachInstance' })
    expect(key('V', 'KeyV', { ctrl: true, shift: true })).toEqual({ kind: 'pasteInPlace' })
    expect(key('g', 'KeyG', { ctrl: true, alt: true })).toEqual({ kind: 'wrapInFrame' })
    expect(key('d', 'KeyD', { ctrl: true })).toEqual({ kind: 'duplicate' })
    expect(key('p', 'KeyP', {})).toEqual({ kind: 'tool', tool: 'pen' })
    expect(key('k', 'KeyK', {})).toEqual({ kind: 'tool', tool: 'component' })
    // Plain Ctrl+V stays with the shell's edit.paste.
    expect(key('v', 'KeyV', { ctrl: true })).toBeNull()
  })
})

describe('groups', () => {
  it('Ctrl+G groups in one undo step, Ctrl+Shift+G ungroups keeping positions', () => {
    const h = harness('f-groups', 1)
    const { art, a, b } = board(h)
    const undo = h.startUndo()
    h.select([a, b])
    const group = h.actions.group() as string
    expect(node(h.doc, group).type).toBe('group')
    expect(getChildIds(h.doc, art)).toEqual([group])
    expect(getChildIds(h.doc, group)).toEqual([a, b])
    expect(node(h.doc, group).styles).toMatchObject({ left: 10, top: 20, width: 120, height: 130 })
    expect(node(h.doc, a).styles).toMatchObject({ position: 'absolute', left: 0, top: 0 })
    expect(h.session.store.getState().selection).toEqual([group])

    h.select([group])
    expect(h.actions.info().groups).toEqual([group])
    expect(h.actions.ungroup()).toEqual([a, b])
    expect(getNode(h.doc, group)).toBeUndefined()
    expect(node(h.doc, b).styles).toMatchObject({ left: 100, top: 120 })

    undo.undo()
    expect(getChildIds(h.doc, art)).toHaveLength(1)
    undo.undo()
    expect(getChildIds(h.doc, art).map((id) => node(h.doc, id).name)).toEqual(['A', 'B'])
  })

  it('layer rows show groups as containers with the group icon kind', () => {
    const h = harness('f-rows', 2)
    const { a, b } = board(h)
    h.select([a, b])
    const group = h.actions.group() as string
    expect(h.session.tree.meta(group)?.kind).toBe('group')
    expect(h.session.tree.children(group)).toEqual([a, b])
  })
})

describe('components', () => {
  function withComponent() {
    const h = harness('f-components', 3)
    const { art, a } = board(h)
    const card = createNode(h.doc, {
      type: 'frame',
      parentId: h.page,
      name: 'Card',
      styles: { left: 600, top: 0, width: 200, height: 100, backgroundColor: '#FF0000' },
    })
    const label = createNode(h.doc, {
      type: 'text',
      parentId: card,
      name: 'Label',
      text: 'Hello',
      styles: { fontSize: '14px' },
    })
    h.select([card])
    const main = h.actions.createComponent() as string
    return { h, art, a, card, label, main }
  }

  it('Ctrl+Alt+K turns a frame into a main; instances follow it and keep overrides', () => {
    const { h, art, main, label } = withComponent()
    expect(main).toBeTruthy()
    const [info] = listComponents(h.doc)
    expect(info?.name).toBe('Card')
    expect(h.session.tree.meta(main)?.kind).toBe('component')

    h.select([art])
    const inst = h.actions.insertInstance(info?.key as string) as string
    expect(node(h.doc, inst)).toMatchObject({ type: 'instance', componentKey: info?.key })
    // The instance takes the main's size (no own width/height).
    expect(node(h.doc, inst).styles['width']).toBeUndefined()
    expect(h.session.tree.meta(inst)?.kind).toBe('instance')
    const rows = h.session.tree.children(inst)
    expect(rows).toHaveLength(1)
    const virtualLabel = rows[0] as string
    expect(h.session.tree.meta(virtualLabel)).toMatchObject({ name: 'Label', virtual: true })

    // Override the text, then edit the main: the override survives, the rest propagates.
    setTextAt(h.doc, virtualLabel, 'Override')
    expect(h.session.resolver.resolveNode(virtualLabel)?.text).toBe('Override')
    setTextAt(h.doc, label, 'Main text')
    expect(h.session.resolver.resolveNode(virtualLabel)?.text).toBe('Override')

    // Reset overrides (one undo step) brings the main's text back.
    const undo = h.startUndo()
    h.select([inst])
    expect(h.actions.info().overridable).toEqual([inst])
    h.actions.resetOverrides()
    expect(h.session.resolver.resolveNode(virtualLabel)?.text).toBe('Main text')
    undo.undo()
    expect(h.session.resolver.resolveNode(virtualLabel)?.text).toBe('Override')
  })

  it('the Components panel counts instances as they come and go', () => {
    const { h, art } = withComponent()
    const watcher = h.session.components
    const off = watcher.subscribe(() => undefined)
    const key = listComponents(h.doc)[0]?.key as string
    expect(watcher.getSnapshot().counts[key] ?? 0).toBe(0)
    h.select([art])
    const one = h.actions.insertInstance(key) as string
    h.actions.insertInstance(key)
    expect(watcher.getSnapshot().list.map((c) => c.name)).toEqual(['Card'])
    expect(watcher.getSnapshot().counts[key]).toBe(2)
    // Deleting the artboard removes both instances (its subtree reports only the root).
    h.select([art])
    h.actions.delete()
    expect(watcher.getSnapshot().counts[key] ?? 0).toBe(0)
    expect(getNode(h.doc, one)).toBeUndefined()
    off()
  })

  it('detach makes the instance a frame with real children (Ctrl+Alt+B)', () => {
    const { h, art } = withComponent()
    const key = listComponents(h.doc)[0]?.key as string
    h.select([art])
    const inst = h.actions.insertInstance(key) as string
    h.select([inst])
    expect(h.actions.detachInstance()).toEqual([inst])
    const detached = node(h.doc, inst)
    expect(detached.type).toBe('frame')
    expect(detached.componentKey).toBeUndefined()
    expect(getChildIds(h.doc, inst).map((id) => node(h.doc, id).text)).toEqual(['Hello'])
  })

  it('never puts a component inside itself (the instance goes to the page instead)', () => {
    const { h, main } = withComponent()
    const key = listComponents(h.doc)[0]?.key as string
    h.select([main])
    const inst = h.actions.insertInstance(key) as string
    expect(node(h.doc, inst).parentId).toBe(h.page)
    expect(getChildIds(h.doc, main).every((id) => node(h.doc, id).type !== 'instance')).toBe(true)
  })

  it('virtual selections disable structure commands', () => {
    const { h, art } = withComponent()
    const key = listComponents(h.doc)[0]?.key as string
    h.select([art])
    const inst = h.actions.insertInstance(key) as string
    const label = virtualId(
      inst,
      node(h.doc, getChildIds(h.doc, listComponents(h.doc)[0]?.mainId as string)[0] as string)
        .nodeKey as string,
    )
    h.select([label])
    expect(h.actions.info()).toMatchObject({ virtual: true, real: [] })
    expect(h.actions.group()).toBeNull()
    expect(h.actions.createComponent()).toBeNull()
  })
})

describe('clipboard', () => {
  it('copies and pastes within a file (one undo step, new ids)', async () => {
    const h = harness('f-copy', 4)
    const { art, a } = board(h)
    const undo = h.startUndo()
    h.select([a])
    expect(await h.actions.copy()).toBe(true)
    h.select([art])
    await h.actions.paste()
    const names = getChildIds(h.doc, art).map((id) => node(h.doc, id).name)
    expect(names).toEqual(['A', 'B', 'A'])
    undo.undo()
    expect(getChildIds(h.doc, art)).toHaveLength(2)
  })

  it('pastes across files with tokens, the component closure and image bytes', async () => {
    const src = harness('f-src', 5)
    setTokens(src.doc, { '--color-brand': { type: 'color', value: '#7B4DFF' } })
    const pixel = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    )
    const hash = await bridge.assets.put(pixel, 'image/png')
    const card = createNode(src.doc, {
      type: 'frame',
      parentId: src.page,
      name: 'Card',
      styles: { left: 0, top: 0, width: 120, height: 80, backgroundColor: 'var(--color-brand)' },
    })
    createNode(src.doc, {
      type: 'image',
      parentId: card,
      name: 'Photo',
      assetId: hash,
      styles: { width: 40, height: 40 },
    })
    src.select([card])
    src.actions.createComponent()
    const key = listComponents(src.doc)[0]?.key as string
    src.select([])
    const inst = src.actions.insertInstance(key) as string
    src.select([inst])
    expect(await src.actions.copy()).toBe(true)

    const read = await bridge.clipboard.read()
    expect(read.baren).toContain('"kind":"baren/clipboard"')
    expect(read.html).toContain('<section')
    expect(read.html).toContain('src="data:image/png;base64,')
    expect(read.text).toBe('Card')

    const dst = harness('f-dst', 6)
    await dst.actions.paste()
    await tick()
    // The token was added, the main created on a "Components" page, the instance pasted.
    expect(getTokens(dst.doc)['--color-brand']?.value).toBe('#7B4DFF')
    const pages = getChildIds(dst.doc, null).map((id) => node(dst.doc, id).name)
    expect(pages).toEqual(['Page 1', 'Components'])
    const pasted = getChildIds(dst.doc, dst.page).map((id) => node(dst.doc, id))
    expect(pasted).toHaveLength(1)
    expect(pasted[0]).toMatchObject({ type: 'instance', componentKey: key })
    expect(listComponents(dst.doc).map((c) => c.key)).toEqual([key])
    // The image bytes travelled with the payload into this file's store.
    expect(await bridge.assets.get(hash)).not.toBeNull()
    const snap = toSnapshot(dst.doc)
    expect(Object.values(snap.nodes).some((n) => n.assetId === hash)).toBe(true)

    // A second paste reuses the main.
    await dst.actions.paste()
    expect(getChildIds(dst.doc, null)).toHaveLength(2)
    expect(listComponents(dst.doc)).toHaveLength(1)
  })

  it('pastes plain text as a text layer and legacy v1 JSON (SVG markup: Playwright)', async () => {
    const h = harness('f-text', 7)
    await bridge.clipboard.write({ text: 'Hello world' })
    await h.actions.paste()
    await bridge.clipboard.write({
      text: JSON.stringify({
        kind: 'baren/nodes',
        version: 1,
        nodes: [
          {
            type: 'rect',
            name: 'Old',
            styles: { left: 5, top: 5, width: 10, height: 10 },
            children: [],
          },
        ],
      }),
    })
    await h.actions.paste()
    const types = getChildIds(h.doc, h.page).map((id) => [
      node(h.doc, id).type,
      node(h.doc, id).name,
    ])
    expect(types).toEqual([
      ['text', 'Hello world'],
      ['rect', 'Old'],
    ])
  })

  it('cut removes after a successful copy; paste in place keeps the position', async () => {
    const h = harness('f-cut', 8)
    const { art, a } = board(h)
    h.select([a])
    await h.actions.cut()
    expect(getChildIds(h.doc, art).map((id) => node(h.doc, id).name)).toEqual(['B'])
    h.select([art])
    await h.actions.pasteInPlace()
    const pasted = getChildIds(h.doc, art)
      .map((id) => node(h.doc, id))
      .find((n) => n.name === 'A')
    expect(pasted?.styles).toMatchObject({ position: 'absolute', left: 10, top: 20 })
  })

  it('refuses payloads from a newer version', async () => {
    const h = harness('f-newer', 9)
    await bridge.clipboard.write({
      baren: JSON.stringify({ kind: 'baren/clipboard', version: 3, nodes: [] }),
      text: 'x',
    })
    await h.actions.paste()
    expect(getChildIds(h.doc, h.page)).toHaveLength(0)
  })
})
