import {
  createCommentThread,
  createEmptyDoc,
  createNode,
  createVersion,
  getChildIds,
  getVersions,
  type CommentAuthor,
  type DocVersion,
} from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { AGENT_IDLE_MS, checkpointBeforeAgentWrite } from '../../agent/checkpoint'
import {
  beforeRestoreName,
  dayTitle,
  groupVersions,
  shouldCheckpointOnOpen,
  versionLabel,
} from './model'

const ana: CommentAuthor = { id: 'u1', name: 'Ana', kind: 'user' }

function version(over: Partial<DocVersion>): DocVersion {
  return {
    id: over.id ?? 'v',
    name: '',
    createdAt: 0,
    author: ana,
    frontiers: [],
    auto: true,
    reason: 'session',
    ...over,
  }
}

function setup() {
  const doc = createEmptyDoc('history', { peerId: 1 })
  const page = getChildIds(doc, null)[0] as string
  return { doc, page }
}

describe('version labels', () => {
  it('uses the name, else a label for the checkpoint reason', () => {
    expect(versionLabel(version({ name: 'Launch', auto: false, reason: 'manual' }))).toBe('Launch')
    expect(versionLabel(version({ reason: 'session' }))).toBe('Opened by Ana')
    expect(
      versionLabel(
        version({ reason: 'agent', author: { id: 'agent:Cursor', name: 'Cursor', kind: 'agent' } }),
      ),
    ).toBe("Before Cursor's edits")
    expect(beforeRestoreName(version({ name: 'Launch' }))).toBe('Before restoring “Launch”')
  })
})

describe('grouping', () => {
  it('lists named versions first, then checkpoints by day, newest first', () => {
    const now = new Date(2026, 9, 4, 15, 0).getTime()
    const today = new Date(2026, 9, 4, 9, 30).getTime()
    const yesterday = new Date(2026, 9, 3, 18, 0).getTime()
    const older = new Date(2026, 8, 20, 12, 0).getTime()
    const groups = groupVersions(
      [
        version({ id: 'a', createdAt: older }),
        version({ id: 'b', createdAt: today }),
        version({ id: 'n', createdAt: yesterday, name: 'Review', auto: false, reason: 'manual' }),
        version({ id: 'c', createdAt: yesterday }),
        version({ id: 'd', createdAt: today + 60_000 }),
      ],
      now,
    )
    expect(groups.map((g) => [g.title, g.versions.map((v) => v.id)])).toEqual([
      ['Named versions', ['n']],
      ['Today', ['d', 'b']],
      ['Yesterday', ['c']],
      [dayTitle(older, now), ['a']],
    ])
  })
})

describe('checkpoints', () => {
  it('on open: only when the design changed since the newest version, never for an empty file', () => {
    const { doc, page } = setup()
    expect(shouldCheckpointOnOpen(doc)).toBe(false)
    createNode(doc, { type: 'frame', parentId: page, name: 'Board' })
    expect(shouldCheckpointOnOpen(doc)).toBe(true)
    createVersion(doc, { name: '', author: ana, auto: true })
    expect(shouldCheckpointOnOpen(doc)).toBe(false)
    createCommentThread(doc, {
      pageId: page,
      nodeId: null,
      x: 0,
      y: 0,
      worldX: 0,
      worldY: 0,
      author: ana,
      body: 'Comments are not design changes',
    })
    expect(shouldCheckpointOnOpen(doc)).toBe(false)
    createNode(doc, { type: 'frame', parentId: page, name: 'Another' })
    expect(shouldCheckpointOnOpen(doc)).toBe(true)
  })

  it("before an agent's writes: once per idle stretch, per agent", () => {
    const { doc, page } = setup()
    createNode(doc, { type: 'frame', parentId: page, name: 'Board' })
    const t0 = 1_000_000
    const first = checkpointBeforeAgentWrite(doc, 'Claude Code', t0)
    expect(getVersions(doc)[0]).toMatchObject({
      id: first,
      name: "Before Claude Code's edits",
      reason: 'agent',
      auto: true,
      author: { name: 'Claude Code', kind: 'agent' },
    })
    createNode(doc, { type: 'frame', parentId: page, name: 'Agent work' })
    // Writing on: no new checkpoint.
    expect(checkpointBeforeAgentWrite(doc, 'Claude Code', t0 + 60_000)).toBeNull()
    // Another agent gets its own, since the design changed.
    expect(checkpointBeforeAgentWrite(doc, 'Cursor', t0 + 120_000)).not.toBeNull()
    createNode(doc, { type: 'frame', parentId: page, name: 'More' })
    // After the idle stretch, the first write records a new one.
    expect(
      checkpointBeforeAgentWrite(doc, 'Claude Code', t0 + 60_000 + AGENT_IDLE_MS),
    ).not.toBeNull()
    // Nothing changed since: no checkpoint even after another idle stretch.
    expect(
      checkpointBeforeAgentWrite(doc, 'Claude Code', t0 + 60_000 + 3 * AGENT_IDLE_MS),
    ).toBeNull()
    expect(getVersions(doc).filter((v) => v.reason === 'agent')).toHaveLength(3)
  })

  it('a reopened host trusts a recent checkpoint of the same agent', () => {
    const { doc, page } = setup()
    createNode(doc, { type: 'frame', parentId: page, name: 'Board' })
    createVersion(doc, {
      name: "Before Claude Code's edits",
      author: { id: 'agent:Claude Code', name: 'Claude Code', kind: 'agent' },
      auto: true,
      reason: 'agent',
      now: 5_000_000,
    })
    createNode(doc, { type: 'frame', parentId: page, name: 'Agent work' })
    // A fresh host (no remembered writes) two minutes later.
    expect(checkpointBeforeAgentWrite(doc, 'Claude Code', 5_000_000 + 120_000)).toBeNull()
  })
})
