import { createEmptyDoc, createNode, getChildIds, getNode, SchemaError } from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { commit, type ToolCall, type ToolSpec } from './context'
import { AgentToolError, toAgentError } from './errors'
import { Dispatcher } from './host/dispatch'
import { dispatch, testEnv } from './testing'

function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}

function setup() {
  const doc = createEmptyDoc('D', { peerId: 3 })
  const page = getChildIds(doc, null)[0] as string
  const env = testEnv(doc)
  return { doc, page, env }
}

describe('Dispatcher (contract §4.6)', () => {
  it('a write cancelled before its transaction changes nothing', async () => {
    const { doc, page, env } = setup()
    const g = gate()
    const tools: Record<string, ToolSpec> = {
      slow: {
        write: true,
        run: async (call: ToolCall) => {
          await g.p
          if (call.signal.aborted) throw new AgentToolError('cancelled', 'cancelled')
          commit(call, () => createNode(doc, { type: 'frame', parentId: page }))
          return { result: {} }
        },
      },
    }
    const d = new Dispatcher(env, { tools })
    const pending = dispatch(env, 'slow', {}, { id: 'c1' }, d)
    await Promise.resolve()
    d.cancel('c1')
    g.open()
    const res = await pending
    expect(!res.ok && res.error.code).toBe('cancelled')
    expect(getChildIds(doc, page)).toEqual([])
  })

  it('a write cancelled after its transaction started completes', async () => {
    const { doc, page, env } = setup()
    const g = gate()
    const committed = gate()
    const tools: Record<string, ToolSpec> = {
      slow: {
        write: true,
        run: async (call: ToolCall) => {
          const id = commit(call, () => createNode(doc, { type: 'frame', parentId: page }))
          committed.open()
          await g.p
          return { result: { id }, touched: [id] }
        },
      },
    }
    const d = new Dispatcher(env, { tools })
    const pending = dispatch(env, 'slow', {}, { id: 'c2' }, d)
    await committed.p
    d.cancel('c2')
    g.open()
    const res = await pending
    expect(res.ok).toBe(true)
    expect(getChildIds(doc, page)).toHaveLength(1)
  })

  it('times out at the deadline', async () => {
    const { env } = setup()
    const tools: Record<string, ToolSpec> = {
      hang: {
        write: false,
        run: async (call: ToolCall) => {
          await new Promise((r) => setTimeout(r, 50))
          if (call.signal.aborted) throw new Error('aborted')
          return { result: {} }
        },
      },
    }
    const d = new Dispatcher(env, { tools })
    const res = await dispatch(env, 'hang', {}, { deadline: Date.now() + 10 }, d)
    expect(!res.ok && res.error.code).toBe('timeout')
  })

  it('serialises writes and lets reads run alongside', async () => {
    const { env } = setup()
    const order: string[] = []
    const g = gate()
    const tools: Record<string, ToolSpec> = {
      w1: {
        write: true,
        run: async () => {
          order.push('w1 start')
          await g.p
          order.push('w1 end')
          return { result: {} }
        },
      },
      w2: {
        write: true,
        run: async () => {
          order.push('w2')
          return { result: {} }
        },
      },
      r: { write: false, run: () => (order.push('r'), { result: {} }) },
    }
    const d = new Dispatcher(env, { tools })
    const a = dispatch(env, 'w1', {}, {}, d)
    const b = dispatch(env, 'w2', {}, {}, d)
    await dispatch(env, 'r', {}, {}, d)
    expect(order).toContain('w1 start')
    expect(order).not.toContain('w2')
    g.open()
    await Promise.all([a, b])
    expect(order.indexOf('r')).toBeLessThan(order.indexOf('w1 end'))
    expect(order.slice(-2)).toEqual(['w1 end', 'w2'])
  })

  it('maps errors onto contract codes', () => {
    expect(toAgentError(new SchemaError('node-not-found', 'x')).code).toBe('node_not_found')
    expect(toAgentError(new SchemaError('cycle', 'x')).code).toBe('cycle')
    expect(toAgentError(new SchemaError('invalid-parent', 'x')).code).toBe('invalid_target')
    const html = Object.assign(new Error('nope'), {
      name: 'HtmlApplyError',
      code: 'instance_content',
    })
    expect(toAgentError(html).code).toBe('instance_content')
    const original = console.error
    console.error = () => undefined
    try {
      expect(toAgentError(new TypeError('boom'))).toEqual({ code: 'internal', message: 'boom' })
    } finally {
      console.error = original
    }
  })

  it('touched is deduplicated; artboards_of carries the header (get_screenshot shows it)', async () => {
    const { doc, page, env } = setup()
    const board = createNode(doc, {
      type: 'frame',
      parentId: page,
      styles: { width: 10, height: 10 },
    })
    const res = await dispatch(env, 'artboards_of', { nodeIds: [board] })
    expect(res.ok && res.header).toMatchObject({ file: { id: expect.any(String) } })
    const info = await dispatch(env, 'get_node_info', { nodeId: board })
    expect(info.ok && info.touched).toEqual([board])
    expect(getNode(doc, board)?.type).toBe('frame')
  })
})
