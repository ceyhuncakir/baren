import { describe, expect, it } from 'vitest'
import { AgentRpc } from './ipc'
import { FakeTarget } from './testing'

describe('AgentRpc (contract §4.6)', () => {
  it('correlates responses by id and passes header, result and touched', async () => {
    const rpc = new AgentRpc()
    const target = new FakeTarget(
      () => rpc,
      (req) => ({
        ok: true,
        header: { file: { id: 'f1', name: 'F' }, contentHash: { tokens: 'deadbeef' } },
        result: { tool: req.tool, args: req.args },
        touched: ['a1'],
      }),
    )
    const [a, b] = await Promise.all([
      rpc.request(target, {
        fileId: 'f1',
        tool: 'get_children',
        args: { nodeId: 'n1' },
        timeoutMs: 1_000,
      }),
      rpc.request(target, {
        fileId: 'f1',
        tool: 'get_node_info',
        args: { nodeId: 'n2' },
        timeoutMs: 1_000,
      }),
    ])
    expect(a.result).toEqual({ tool: 'get_children', args: { nodeId: 'n1' } })
    expect(b.result).toEqual({ tool: 'get_node_info', args: { nodeId: 'n2' } })
    expect(a.touched).toEqual(['a1'])
    expect(target.requests.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(target.requests[0]!.deadline).toBeGreaterThan(Date.now())
    expect(rpc.inFlight).toBe(0)
  })

  it('maps error responses to ToolErrors', async () => {
    const rpc = new AgentRpc()
    const target = new FakeTarget(
      () => rpc,
      () => ({ ok: false, error: { code: 'node_not_found', message: 'No node 1@2' } }),
    )
    await expect(
      rpc.request(target, { fileId: 'f', tool: 'get_node_info', args: {}, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'node_not_found', message: 'No node 1@2' })
  })

  it('ignores responses from another window', async () => {
    const rpc = new AgentRpc()
    const target = new FakeTarget(
      () => rpc,
      () => null,
    )
    const pending = rpc.request(target, {
      fileId: 'f',
      tool: 'get_selection',
      args: {},
      timeoutMs: 50,
    })
    const id = target.requests[0]!.id
    rpc.handleResponse(target.webContentsId + 1, { id, ok: true, header: null, result: 1 })
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
  })

  it('times out with agent:cancel', async () => {
    const rpc = new AgentRpc()
    const target = new FakeTarget(
      () => rpc,
      () => null,
    )
    await expect(
      rpc.request(target, { fileId: 'f', tool: 'write_html', args: {}, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(target.cancels).toEqual([target.requests[0]!.id])
  })

  it('cancels on abort with agent:cancel, and refuses already-aborted calls', async () => {
    const rpc = new AgentRpc()
    const target = new FakeTarget(
      () => rpc,
      () => null,
    )
    const controller = new AbortController()
    const pending = rpc.request(target, {
      fileId: 'f',
      tool: 'get_screenshot',
      args: {},
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(target.cancels).toHaveLength(1)
    await expect(
      rpc.request(target, {
        fileId: 'f',
        tool: 'flush',
        args: {},
        timeoutMs: 10,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('fails pending requests of a window that went away', async () => {
    const rpc = new AgentRpc()
    const target = new FakeTarget(
      () => rpc,
      () => null,
    )
    const pending = rpc.request(target, {
      fileId: 'f',
      tool: 'get_tree_summary',
      args: {},
      timeoutMs: 5_000,
    })
    expect(rpc.inFlightFor(target.webContentsId)).toBe(1)
    rpc.targetGone(target.webContentsId)
    await expect(pending).rejects.toMatchObject({ code: 'host_unavailable' })
    target.destroyed = true
    await expect(
      rpc.request(target, { fileId: 'f', tool: 'get_tree_summary', args: {}, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('cancels everything on quit', async () => {
    const rpc = new AgentRpc()
    const target = new FakeTarget(
      () => rpc,
      () => null,
    )
    const pending = rpc.request(target, { fileId: 'f', tool: 'export', args: {}, timeoutMs: 5_000 })
    rpc.cancelAll()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })
})
