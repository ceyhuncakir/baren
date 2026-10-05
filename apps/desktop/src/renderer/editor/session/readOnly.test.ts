/**
 * View-only editing: who counts as a viewer (room role, else team role), and that a viewer's
 * edit commands, tools and panel writes leave the document alone (the server would drop them).
 */
import { createEmptyDoc, createNode, getChildIds, toSnapshot } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorActions } from '../commands/actions'
import { runTool } from '../commands/tools'
import { LayerTree } from '../model/layerTree'
import type { EditorSession } from './context'
import { DocEvents } from './docEvents'
import { canEdit, isReadOnly, isViewer } from './readOnly'
import { createEditorStore } from './store'

const toast = vi.hoisted(() => vi.fn())
vi.mock('@baren/ui', async (original) => ({
  ...(await original<typeof import('@baren/ui')>()),
  toast,
}))

type Role = 'admin' | 'editor' | 'viewer'

function welcome(role: Role) {
  return { type: 'welcome' as const, clientId: 'c1', userId: 'u1', name: 'Me', color: '#000', role }
}

const sessions: { dispose(): void }[] = []

function session(opts: { room?: Role; team?: Role } = {}): { s: EditorSession; doc: LoroDoc } {
  const doc = createEmptyDoc('f')
  const page = getChildIds(doc, null)[0] as string
  createNode(doc, {
    type: 'rect',
    parentId: page,
    styles: { left: 0, top: 0, width: 10, height: 10 },
  })
  const events = new DocEvents(doc)
  const tree = new LayerTree(doc, events.resolver)
  events.subscribe((b, a) => tree.apply(b, a))
  const store = createEditorStore({ pageId: page, accountLoaded: true })
  if (opts.room) store.setState({ self: welcome(opts.room) })
  let s: EditorSession
  const actions = new EditorActions(() => s)
  s = {
    fileId: 'f',
    doc,
    events,
    resolver: events.resolver,
    tree,
    store,
    canvas: { current: null },
    canvasEl: { current: null },
    actions,
    teams: opts.team ? [{ id: 't1', role: opts.team }] : [],
    file: { id: 'f', teamId: opts.team ? 't1' : null },
  } as unknown as EditorSession
  sessions.push(events)
  return { s, doc }
}

// canEdit's notice is rate-limited by time: every test starts a minute after the last one.
let clock = Date.now()

beforeEach(() => {
  toast.mockClear()
  vi.useFakeTimers()
  clock += 60_000
  vi.setSystemTime(clock)
})

afterEach(() => {
  vi.useRealTimers()
  for (const e of sessions.splice(0)) e.dispose()
})

describe('isViewer', () => {
  it('uses the role from the live room, else the role in the file’s team', () => {
    expect(isViewer(session({ room: 'viewer' }).s)).toBe(true)
    expect(isViewer(session({ room: 'editor' }).s)).toBe(false)
    expect(isViewer(session({ team: 'viewer' }).s)).toBe(true)
    // The room has the last word (a role changed since the account loaded).
    expect(isViewer(session({ room: 'editor', team: 'viewer' }).s)).toBe(false)
    // Local files and unknown roles are editable.
    expect(isViewer(session().s)).toBe(false)
  })

  it('treats a version preview as read-only for everyone', () => {
    const { s } = session({ room: 'admin' })
    expect(isReadOnly(s)).toBe(false)
    s.store.setState({ previewVersionId: 'v1' })
    expect(isReadOnly(s)).toBe(true)
    expect(canEdit(s)).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('a viewer', () => {
  it('is told once (not on every refused write) why nothing changes', () => {
    const { s } = session({ room: 'viewer' })
    expect(canEdit(s)).toBe(false)
    expect(canEdit(s)).toBe(false)
    expect(toast).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000)
    expect(canEdit(s)).toBe(false)
    expect(toast).toHaveBeenCalledTimes(2)
  })

  it('cannot change the document through edit commands', () => {
    const { s, doc } = session({ room: 'viewer' })
    const page = s.store.getState().pageId
    const rect = getChildIds(doc, page)[0] as string
    s.store.setState({ selection: [rect] })
    const before = JSON.stringify(toSnapshot(doc))
    s.actions.delete()
    s.actions.duplicate()
    expect(s.actions.group()).toBeNull()
    s.actions.addFlex()
    s.actions.toggleHide()
    s.actions.toggleLock()
    s.actions.bringToFront()
    s.actions.rotate90()
    s.actions.rename()
    expect(JSON.stringify(toSnapshot(doc))).toBe(before)
    expect(s.store.getState().renamingId).toBeNull()
  })

  it('keeps the select and hand tools but no drawing or insert tools', () => {
    const { s } = session({ team: 'viewer' })
    runTool(s, 'hand')
    expect(s.store.getState().tool).toBe('hand')
    runTool(s, 'rectangle')
    runTool(s, 'component')
    runTool(s, 'insert')
    expect(s.store.getState().tool).toBe('hand')
    expect(s.store.getState().componentPickerOpen).toBe(false)
    expect(s.store.getState().insertOpen).toBe(false)
  })
})

describe('an editor', () => {
  it('changes the document as before', () => {
    const { s, doc } = session({ room: 'editor', team: 'viewer' })
    const page = s.store.getState().pageId
    const rect = getChildIds(doc, page)[0] as string
    s.store.setState({ selection: [rect] })
    expect(s.actions.group()).not.toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })
})
