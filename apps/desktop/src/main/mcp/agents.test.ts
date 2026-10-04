import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRegistry,
  KeyedThrottle,
  RECENT_MAX,
  RecentAgentsStore,
  baseDisplayName,
  newPresenceId,
} from './agents'

describe('display names (contract §4.4)', () => {
  it('prefers clientInfo.title, then the known-name map, then the raw name', () => {
    expect(baseDisplayName({ name: 'claude-code', title: 'Claude Code (beta)' })).toBe(
      'Claude Code (beta)',
    )
    expect(baseDisplayName({ name: 'claude-code' })).toBe('Claude Code')
    expect(baseDisplayName({ name: 'Claude-Code-Extension' })).toBe('Claude Code')
    expect(baseDisplayName({ name: 'claude-ai' })).toBe('Claude')
    expect(baseDisplayName({ name: 'claude' })).toBe('Claude')
    expect(baseDisplayName({ name: 'cursor-vscode' })).toBe('Cursor')
    expect(baseDisplayName({ name: 'codex-mcp-client' })).toBe('Codex')
    expect(baseDisplayName({ name: 'Visual Studio Code' })).toBe('VS Code')
    expect(baseDisplayName({ name: 'vscode' })).toBe('VS Code')
    expect(baseDisplayName({ name: 'windsurf-client' })).toBe('Windsurf')
    expect(baseDisplayName({ name: 'Zed' })).toBe('Zed')
    expect(baseDisplayName({ name: 'gemini-cli-mcp-client' })).toBe('Gemini CLI')
    expect(baseDisplayName({ name: 'mcp-inspector' })).toBe('MCP Inspector')
    expect(baseDisplayName({ name: 'inspector-client' })).toBe('MCP Inspector')
    expect(baseDisplayName({ name: 'baren-e2e' })).toBe('baren-e2e')
  })

  it('trims to 32 characters, strips control characters, falls back to "Agent"', () => {
    expect(baseDisplayName({ name: 'x'.repeat(40) })).toHaveLength(32)
    expect(baseDisplayName({ name: '  \u0007 ' })).toBe('Agent')
    expect(baseDisplayName({ name: '' })).toBe('Agent')
    expect(baseDisplayName(null)).toBe('Agent')
  })

  it('generates 12-character base36 presence ids', () => {
    expect(newPresenceId()).toMatch(/^[0-9a-z]{12}$/)
  })
})

describe('AgentRegistry', () => {
  let now = 1_000_000
  const clock = () => now
  beforeEach(() => {
    now = 1_000_000
  })

  function registry(extra: Partial<ConstructorParameters<typeof AgentRegistry>[0]> = {}) {
    const presence: string[] = []
    const reg = new AgentRegistry({
      now: clock,
      onFilePresence: (fileId) => presence.push(fileId),
      ...extra,
    })
    return { reg, presence }
  }

  it('names sessions on identify; sessions with the same name are one agent', () => {
    const { reg } = registry()
    reg.open('s1')
    reg.identify('s1', { name: 'claude-code', version: '2.0.1' })
    reg.open('s2', { name: 'claude-code' })
    reg.open('s3', { name: 'cursor' })
    expect(reg.get('s1')).toMatchObject({
      name: 'Claude Code',
      client: 'claude-code',
      version: '2.0.1',
    })
    expect(reg.get('s2')?.name).toBe('Claude Code')
    expect(reg.get('s2')?.presenceId).toBe(reg.get('s1')?.presenceId)
    expect(reg.get('s3')?.presenceId).not.toBe(reg.get('s1')?.presenceId)
    // A reconnect keeps the agent's presence id.
    const id = reg.get('s1')!.presenceId
    reg.close('s1')
    reg.close('s2')
    reg.open('s4', { name: 'claude-code' })
    expect(reg.get('s4')?.presenceId).toBe(id)
  })

  it('merges the sessions of one agent in presence, status and releases', () => {
    const { reg } = registry()
    reg.open('s1', { name: 'copy' })
    reg.noteCall('s1', 'f1', 'File')
    reg.touch('s1', 'f1', ['a1'], true)
    now += 1_000
    reg.open('s2', { name: 'copy' })
    reg.noteCall('s2', 'f1', 'File')
    reg.touch('s2', 'f1', ['a1', 'a2'], true)
    now += 1_000
    reg.open('s3', { name: 'copy' })

    const presence = reg.presenceFor('f1')
    expect(presence).toHaveLength(1)
    expect(presence[0]).toMatchObject({
      name: 'copy',
      working: ['a1', 'a2'],
      activeAt: now - 1_000,
    })

    const status = reg.statusAgents()
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({
      name: 'copy',
      connected: true,
      connectedAt: 1_000_000,
      lastFileName: 'File',
      files: [{ fileId: 'f1', working: ['a1', 'a2'] }],
    })

    // Any session of the agent sees and releases the agent's indicators.
    expect(reg.working('s3').get('f1')).toEqual(['a1', 'a2'])
    expect(reg.release('s3', 'f1', ['a1'])).toEqual({ released: ['a1'], remaining: ['a2'] })
    expect(reg.presenceFor('f1')[0]!.working).toEqual(['a2'])
    expect(reg.release('s1', null, null)).toEqual({ released: ['a2'], remaining: [] })
    expect(reg.hasWorkingSet('f1')).toBe(false)
  })

  it('adds written artboards to the working set, renews on reads, expires after 120 s', () => {
    const { reg, presence } = registry()
    reg.open('s1', { name: 'cursor' })
    reg.noteCall('s1', 'f1', 'File')
    reg.touch('s1', 'f1', ['a1'], true)
    expect(reg.working('s1').get('f1')).toEqual(['a1'])
    expect(reg.hasWorkingSet('f1')).toBe(true)
    // A read of an artboard not in the set does not add it.
    reg.touch('s1', 'f1', ['a2'], false)
    expect(reg.working('s1').get('f1')).toEqual(['a1'])
    now += 100_000
    reg.touch('s1', 'f1', ['a1'], false) // renewed
    now += 100_000
    reg.sweep()
    expect(reg.working('s1').get('f1')).toEqual(['a1'])
    now += 21_000
    reg.sweep()
    expect(reg.working('s1').get('f1')).toBeUndefined()
    expect(reg.hasWorkingSet('f1')).toBe(false)
    expect(presence.filter((f) => f === 'f1').length).toBeGreaterThanOrEqual(2)
  })

  it('releases all, per file, or by artboard id; never fails for unknown ids', () => {
    const { reg } = registry()
    reg.open('s1', { name: 'codex' })
    reg.touch('s1', 'f1', ['a1', 'a2'], true)
    reg.touch('s1', 'f2', ['b1'], true)
    expect(reg.release('s1', 'f1', ['a2', 'zzz'])).toEqual({ released: ['a2'], remaining: ['a1'] })
    expect(reg.release('s1', null, ['nope'])).toEqual({ released: [], remaining: ['a1', 'b1'] })
    expect(reg.release('s1', null, null)).toEqual({ released: ['a1', 'b1'], remaining: [] })
    expect(reg.release('missing', null, null)).toEqual({ released: [], remaining: [] })
  })

  it('lists presence for a file: active in the last 10 min or working there', () => {
    const { reg, presence } = registry()
    reg.open('s1', { name: 'claude-code' })
    reg.open('s2', { name: 'cursor' })
    reg.noteCall('s1', 'f1', 'File')
    reg.touch('s2', 'f1', ['a1'], true)
    const list = reg.presenceFor('f1')
    expect(list.map((a) => [a.name, a.working])).toEqual([
      ['Claude Code', []],
      ['Cursor', ['a1']],
    ])
    expect(list[0]!.id).toBe(reg.get('s1')!.presenceId)
    now += 11 * 60_000
    presence.length = 0
    reg.sweep() // a1 expired and s1 went quiet
    expect(reg.presenceFor('f1')).toEqual([])
    expect(presence).toContain('f1')
    reg.close('s2')
    expect(reg.presenceFor('f1')).toEqual([])
  })

  it('forgets deleted artboards and clears everything when a session closes', () => {
    const { reg, presence } = registry()
    reg.open('s1', { name: 'x' })
    reg.touch('s1', 'f1', ['a1', 'a2'], true)
    reg.forget('f1', ['a1'])
    expect(reg.working('s1').get('f1')).toEqual(['a2'])
    presence.length = 0
    reg.close('s1')
    expect(presence).toEqual(['f1'])
    expect(reg.size).toBe(0)
  })

  it('reports live sessions first, then recent agents without a live session', () => {
    const recent = {
      list: () => [
        {
          name: 'Cursor',
          client: 'cursor',
          lastActivityAt: 5,
          lastFileId: 'f9',
          lastFileName: 'Old',
        },
        {
          name: 'Claude Code',
          client: 'claude-code',
          lastActivityAt: 4,
          lastFileId: null,
          lastFileName: null,
        },
      ],
      update: vi.fn(),
    }
    const { reg } = registry({ recent: recent as unknown as RecentAgentsStore })
    reg.open('s1', { name: 'claude-code' })
    reg.noteCall('s1', 'f1', 'File one')
    reg.touch('s1', 'f1', ['a1'], true)
    const status = reg.statusAgents()
    expect(status.map((a) => [a.name, a.connected])).toEqual([
      ['Claude Code', true],
      ['Cursor', false],
    ])
    expect(status[0]).toMatchObject({
      lastFileId: 'f1',
      lastFileName: 'File one',
      files: [{ fileId: 'f1', working: ['a1'] }],
    })
    expect(recent.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Claude Code', lastFileName: 'File one' }),
    )
  })
})

describe('RecentAgentsStore (agents.json)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baren-agents-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps at most 10 entries, drops entries older than 30 days, writes on flush', async () => {
    let now = 100 * 24 * 60 * 60_000
    const path = join(dir, 'agents.json')
    const store = new RecentAgentsStore(path, { now: () => now, writeIntervalMs: 60_000 })
    for (let i = 0; i < 12; i++) {
      store.update({
        name: `A${i}`,
        client: 'c',
        lastActivityAt: now - i,
        lastFileId: null,
        lastFileName: null,
      })
    }
    expect(store.list()).toHaveLength(RECENT_MAX)
    expect(store.list()[0]!.name).toBe('A0')
    await store.flush()
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.version).toBe(1)
    expect(saved.agents).toHaveLength(10)
    now += 31 * 24 * 60 * 60_000
    const reloaded = new RecentAgentsStore(path, { now: () => now })
    await reloaded.load()
    expect(reloaded.list()).toEqual([])
  })

  it('writes at most once a minute', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const writes: string[] = []
      const store = new RecentAgentsStore('/unused', {
        now: () => now,
        write: async (_p, text) => {
          writes.push(text)
        },
      })
      store.update({
        name: 'A',
        client: 'c',
        lastActivityAt: 1,
        lastFileId: null,
        lastFileName: null,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(writes).toHaveLength(1)
      now = 1_000
      store.update({
        name: 'B',
        client: 'c',
        lastActivityAt: 2,
        lastFileId: null,
        lastFileName: null,
      })
      store.update({
        name: 'C',
        client: 'c',
        lastActivityAt: 3,
        lastFileId: null,
        lastFileName: null,
      })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(writes).toHaveLength(1)
      now = 61_000
      await vi.advanceTimersByTimeAsync(30_000)
      expect(writes).toHaveLength(2)
      expect(JSON.parse(writes[1]!).agents.map((a: { name: string }) => a.name)).toEqual([
        'C',
        'B',
        'A',
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('KeyedThrottle', () => {
  it('fires at most once per interval per key with the latest state', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const fired: string[] = []
      const t = new KeyedThrottle(
        100,
        (k) => fired.push(`${k}@${now}`),
        () => now,
      )
      t.push('a')
      t.push('a') // trailing: 100 ms after the first
      t.push('b')
      expect(fired).toEqual(['a@0', 'b@0'])
      now = 50
      t.push('a') // coalesced into the pending trailing call
      await vi.advanceTimersByTimeAsync(50)
      expect(fired).toEqual(['a@0', 'b@0'])
      now = 100
      await vi.advanceTimersByTimeAsync(50)
      expect(fired).toEqual(['a@0', 'b@0', 'a@100'])
      t.cancel()
    } finally {
      vi.useRealTimers()
    }
  })
})
