import { describe, expect, it } from 'vitest'
import { ToolError } from './format'
import { HostRegistry, type VisibleWindowInfo } from './hosts'
import { AgentRpc } from './ipc'
import { FakeHeadless, FakeTarget } from './testing'

function setup(opts: { startTimeoutMs?: number; maxHeadless?: number; now?: () => number } = {}) {
  const rpc = new AgentRpc()
  const visible: VisibleWindowInfo[] = []
  const headless: FakeHeadless[] = []
  const released: string[] = []
  const working = new Set<string>()
  const hosts = new HostRegistry({
    visibleWindows: () => visible,
    createHeadless: (fileId) => {
      const win = new FakeHeadless(
        () => rpc,
        () => null,
      )
      headless.push(win)
      // The page announces itself like the runtime's headless root does.
      queueMicrotask(() => hosts.hostState(win, { fileId, state: 'opened', headless: true }))
      return win
    },
    release: async (target, fileId) => {
      released.push(fileId)
      hosts.hostState(target, { fileId, state: 'closed', headless: true })
    },
    hasWorkingSet: (fileId) => working.has(fileId),
    inFlight: (id) => rpc.inFlightFor(id),
    startTimeoutMs: opts.startTimeoutMs ?? 2_000,
    maxHeadless: opts.maxHeadless ?? 4,
    idleMs: 1_000,
    ...(opts.now ? { now: opts.now } : {}),
  })
  const window = (focusedAt: number, focused = false) => {
    const target = new FakeTarget(() => rpc)
    visible.push({ target, focusedAt, focused })
    return target
  }
  return { rpc, hosts, visible, headless, released, working, window }
}

describe('HostRegistry (contract §4.5)', () => {
  it('picks the focused window file, else the most recently focused one', () => {
    const { hosts, window, visible } = setup()
    const a = window(10)
    const b = window(20)
    const home = window(30) // focused most recently but hosts nothing
    expect(hosts.defaultFileId()).toBeNull()
    hosts.hostState(a, { fileId: 'fa', state: 'opened', headless: false })
    hosts.hostState(b, { fileId: 'fb', state: 'opened', headless: false })
    expect(hosts.defaultFileId()).toBe('fb')
    expect(hosts.visibleFileIds()).toEqual(['fb', 'fa'])
    visible.find((v) => v.target === a)!.focused = true
    expect(hosts.defaultFileId()).toBe('fa')
    expect(hosts.fileOf(home.webContentsId)).toBeNull()
    hosts.hostState(a, { fileId: 'fa', state: 'closed', headless: false })
    expect(hosts.defaultFileId()).toBe('fb')
    hosts.webContentsGone(b.webContentsId)
    expect(hosts.defaultFileId()).toBeNull()
  })

  it('routes to the most recently focused visible window that has the file', async () => {
    const { hosts, window } = setup()
    const a = window(10)
    const b = window(20)
    hosts.hostState(a, { fileId: 'f', state: 'opened', headless: false })
    hosts.hostState(b, { fileId: 'f', state: 'opened', headless: false })
    expect((await hosts.acquire('f')).target).toBe(b)
    expect(hosts.targetsFor('f')).toHaveLength(2)
  })

  it('starts one headless host for a file no window has open and reuses it', async () => {
    const { hosts, headless } = setup()
    const [first, second] = await Promise.all([hosts.acquire('f1'), hosts.acquire('f1')])
    expect(first.headless).toBe(true)
    expect(first.target).toBe(second.target)
    expect(headless).toHaveLength(1)
    expect(hosts.isHeadless(first.target.webContentsId)).toBe(true)
    expect((await hosts.acquire('f1')).target).toBe(first.target)
    expect(hosts.headlessCount).toBe(1)
  })

  it('fails with host_unavailable when the headless host never opens', async () => {
    const rpc = new AgentRpc()
    const wins: FakeHeadless[] = []
    const hosts = new HostRegistry({
      visibleWindows: () => [],
      createHeadless: () => {
        const w = new FakeHeadless(
          () => rpc,
          () => null,
        )
        wins.push(w)
        return w
      },
      release: async () => undefined,
      hasWorkingSet: () => false,
      inFlight: () => 0,
      startTimeoutMs: 30,
    })
    await expect(hosts.acquire('f')).rejects.toMatchObject({ code: 'host_unavailable' })
    expect(wins[0]!.destroyCalls).toBe(1)
    expect(hosts.headlessCount).toBe(0)
  })

  it('releases the least recently used idle headless host at the limit', async () => {
    let now = 0
    const { hosts, released } = setup({ maxHeadless: 2, now: () => now })
    await hosts.acquire('f1')
    now = 10
    await hosts.acquire('f2')
    now = 20
    hosts.noteUse('f1')
    now = 30
    await hosts.acquire('f3')
    expect(released).toEqual(['f2'])
    expect(hosts.headlessFiles().sort()).toEqual(['f1', 'f3'])
  })

  it('never releases a host that is serving a request to make room for another file', async () => {
    const { hosts, released } = setup({ maxHeadless: 1 })
    const busy = await hosts.lease('f1')
    let routed = false
    const next = hosts.acquire('f2').then((r) => {
      routed = true
      return r
    })
    await new Promise((r) => setTimeout(r, 30))
    // f1's request is still running: f2 waits instead of cancelling it.
    expect(released).toEqual([])
    expect(routed).toBe(false)
    busy.done()
    const r = await next
    expect(r.headless).toBe(true)
    expect(released).toEqual(['f1'])
    expect(hosts.headlessFiles()).toEqual(['f2'])
  })

  it('a handoff lets requests already routed to the headless host finish first', async () => {
    const { hosts, released, window } = setup()
    const read = await hosts.lease('f')
    const win = window(50, true)
    let handedOff = false
    const handoff = hosts.beforeVisibleOpen('f', win.webContentsId).then(() => {
      handedOff = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(released).toEqual([])
    expect(handedOff).toBe(false)
    read.done()
    await handoff
    expect(released).toEqual(['f'])
  })

  it('discards a hung headless host (no answer to a ping) and opens the file in a new one', async () => {
    const { hosts, headless } = setup()
    const first = await hosts.acquire('f')
    // Slow but alive: kept.
    await hosts.probe(first.target, async () => undefined)
    expect(headless[0]!.destroyCalls).toBe(0)
    expect((await hosts.acquire('f')).target).toBe(first.target)
    // Hung: destroyed, and the next request gets a fresh host.
    await hosts.probe(first.target, async () => {
      throw new ToolError('timeout', 'flush did not finish within 2 s')
    })
    expect(headless[0]!.destroyCalls).toBe(1)
    const second = await hosts.acquire('f')
    expect(second.target).not.toBe(first.target)
    expect(headless).toHaveLength(2)
  })

  it('releases idle headless hosts, but not while agents work in the file', async () => {
    let now = 0
    const { hosts, released, working } = setup({ now: () => now })
    await hosts.acquire('f1')
    await hosts.acquire('f2')
    working.add('f2')
    now = 5_000
    await hosts.sweep()
    expect(released).toEqual(['f1'])
    expect(hosts.headlessFiles()).toEqual(['f2'])
  })

  it('hands a headless file to a visible window: release first, requests wait for the window', async () => {
    const { hosts, released, window, headless } = setup()
    const first = await hosts.acquire('f')
    expect(first.headless).toBe(true)
    const win = window(50, true)
    await hosts.beforeVisibleOpen('f', win.webContentsId)
    expect(released).toEqual(['f'])
    expect(headless[0]!.destroyCalls).toBe(1)
    // A request now waits for the visible window instead of starting a new headless host.
    const pending = hosts.acquire('f')
    await new Promise((r) => setTimeout(r, 10))
    hosts.hostState(win, { fileId: 'f', state: 'opened', headless: false })
    const routed = await pending
    expect(routed).toEqual({ target: win, headless: false })
    expect(headless).toHaveLength(1)
  })

  it('ignores files:open from the headless host itself', async () => {
    const { hosts, released } = setup()
    const { target } = await hosts.acquire('f')
    await hosts.beforeVisibleOpen('f', target.webContentsId)
    expect(released).toEqual([])
    expect((await hosts.acquire('f')).target).toBe(target)
  })

  it('waits for a visible open (open_file) and gives up after the deadline', async () => {
    const { hosts, window } = setup()
    const win = window(1)
    const waiting = hosts.waitVisible('f', 1_000)
    hosts.hostState(win, { fileId: 'f', state: 'opened', headless: false })
    expect(await waiting).toBe(win)
    await expect(hosts.waitVisible('other', 20)).rejects.toBeInstanceOf(ToolError)
  })

  it('stops waiting when the request is cancelled', async () => {
    const { hosts, window } = setup()
    const win = window(1)
    await hosts.beforeVisibleOpen('f', win.webContentsId)
    const controller = new AbortController()
    const pending = hosts.acquire('f', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('releases every headless host on quit', async () => {
    const { hosts, released } = setup()
    await hosts.acquire('a')
    await hosts.acquire('b')
    await hosts.releaseAll(100)
    expect(released.sort()).toEqual(['a', 'b'])
    expect(hosts.headlessCount).toBe(0)
  })
})
