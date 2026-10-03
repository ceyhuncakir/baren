/**
 * "Copy as → Agent context" (selectionContext.ts) against real Loro documents built with the
 * agent tools: what a pasted selection tells an agent, and its limits.
 */
import {
  createComponent,
  createEmptyDoc,
  createInstance,
  docGeometry,
  getChildIds,
  getNode,
  setNodeProps,
} from '@baren/schema'
import { describe, expect, it } from 'vitest'
import {
  MAX_NODES,
  MAX_NODE_JSX,
  selectionContext,
  type SelectionContextInput,
} from './selectionContext'
import { ok, testEnv } from './testing'

async function setup() {
  const doc = createEmptyDoc('Landing', { peerId: 9 })
  const page = getChildIds(doc, null)[0] as string
  const env = testEnv(doc)
  const board = await ok<{ id: string }>(env, 'create_artboard', {
    name: 'Landing',
    styles: { width: '800px', height: '600px' },
  })
  const written = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
    targetNodeId: board.id,
    mode: 'insert-children',
    html: `<div layer-name="Hero" style="display:flex;flex-direction:column;gap:12px;padding:48px">
  <h1 layer-name="Heading" style="font-size:40px;color:#111111">Design live</h1>
  <p layer-name="Sub" style="font-size:16px">Every layer is real HTML</p>
</div>`,
  })
  const hero = written.createdNodes[0]?.id as string
  const [heading, sub] = getChildIds(doc, hero) as [string, string]
  return { doc, page, env, board: board.id, hero, heading, sub }
}

function input(
  env: ReturnType<typeof testEnv>,
  refs: string[],
  extra: Partial<SelectionContextInput> = {},
): SelectionContextInput {
  return { ctx: env, refs, fileId: 'file-1', fileName: 'Landing', ...extra }
}

/** A frame of `n` paragraphs in the artboard; returns the frame and its children. */
async function paragraphs(env: ReturnType<typeof testEnv>, board: string, n: number) {
  const items = Array.from({ length: n }, (_, i) => `<p style="font-size:14px">Item ${i + 1}</p>`)
  const out = await ok<{ createdNodes: { id: string }[] }>(env, 'write_html', {
    targetNodeId: board,
    mode: 'insert-children',
    html: `<div layer-name="List" style="display:flex;flex-direction:column">${items.join('')}</div>`,
  })
  const list = out.createdNodes[0]?.id as string
  return { list, items: getChildIds(env.doc, list) }
}

describe('selectionContext (Copy as → Agent context)', () => {
  it('says where a layer is, what it is, its JSX and the ids the MCP tools take', async () => {
    const { env, heading } = await setup()
    const text = selectionContext(
      input(env, [heading], {
        frameOf: (ref) => (ref === heading ? { width: 704, height: 48, rotation: 0 } : null),
      }),
    )
    const lines = text.split('\n')
    expect(lines[0]).toBe('<baren-selection file="Landing" fileId="file-1" page="Page 1">')
    expect(lines[1]).toContain('pass fileId and a nodeId')
    expect(lines[2]).toBe(
      `<node nodeId="${heading}" name="Heading" type="Text" path="Landing / Hero / Heading" size="704×48">`,
    )
    // get_jsx's inline-styles markup with ids, without its `( … )` wrapper or indentation.
    expect(lines[3]).toMatch(new RegExp(`^<div data-node-id="${heading}" style=\\{\\{`))
    expect(lines[3]).toContain("fontSize: '40px'")
    expect(text).toContain('  Design live\n')
    expect(lines).not.toContain('(')
    expect(lines.at(-2)).toBe('</node>')
    expect(lines.at(-1)).toBe('</baren-selection>')
  })

  it('lists every selected layer in order, with rotation when there is one', async () => {
    const { env, heading, sub } = await setup()
    const text = selectionContext(
      input(env, [heading, sub], {
        frameOf: (ref) =>
          ref === sub
            ? { width: 300, height: 24, rotation: 15 }
            : { width: 704, height: 48, rotation: 0 },
      }),
    )
    const tags = text.split('\n').filter((l) => l.startsWith('<node '))
    expect(tags).toHaveLength(2)
    expect(tags[0]).toContain(`nodeId="${heading}"`)
    expect(tags[0]).not.toContain('rotation=')
    expect(tags[1]).toContain(`nodeId="${sub}" name="Sub"`)
    expect(tags[1]).toContain('size="300×24" rotation="15°"')
    expect(text).toContain('Every layer is real HTML')
  })

  it('outlines a layer whose JSX is too long: its children, their ids and get_jsx', async () => {
    const { env, board } = await setup()
    const { list, items } = await paragraphs(env, board, 120)
    const text = selectionContext(input(env, [list]))
    expect(text).toMatch(/Its JSX \(\d+ KB\) is too long to include here; get_jsx returns it\./)
    expect(text.length).toBeLessThan(MAX_NODE_JSX)
    expect(text).toContain('Children:')
    expect(text).toContain(`(Text) nodeId=${items[0]}`)
    expect(text).not.toContain(`nodeId=${items[20]}`)
    expect(text).toContain('- … 100 more')
    expect(text).not.toContain('style={{')
  })

  it('names instances and the layers inside them by their component', async () => {
    const { doc, page, env, hero } = await setup()
    createComponent(doc, [hero], docGeometry(doc))
    const key = getNode(doc, hero)?.componentKey as string
    const inst = createInstance(doc, {
      componentKey: key,
      parentId: page,
      styles: { left: 2000, top: 0 },
    })
    const inside = env.resolver.resolveNode(inst)?.children[0] as string
    expect(inside).toContain('/')
    const text = selectionContext(input(env, [inst, inside]))
    expect(text).toContain(`<node nodeId="${inst}" name="Hero" type="Instance" instanceOf="Hero"`)
    expect(text).toContain(
      `<node nodeId="${inside}" name="Heading" type="Text" insideInstanceOf="Hero"`,
    )
    expect(text).toContain(`data-node-id="${inside}"`)
  })

  it('escapes names in attributes', async () => {
    const { doc, env, heading } = await setup()
    setNodeProps(doc, heading, { name: 'Say "hi"\n<now> & go' })
    const text = selectionContext(input(env, [heading], { fileName: 'A "b" file' }))
    expect(text).toContain('file="A &quot;b&quot; file"')
    expect(text).toContain('name="Say &quot;hi&quot; &lt;now&gt; &amp; go"')
  })

  it(`describes at most ${MAX_NODES} layers and counts the rest; pages are skipped`, async () => {
    const { env, board, page } = await setup()
    const { items } = await paragraphs(env, board, MAX_NODES + 5)
    const text = selectionContext(input(env, [page, ...items]))
    expect(text.split('\n').filter((l) => l.startsWith('<node '))).toHaveLength(MAX_NODES)
    expect(text).not.toContain(`nodeId="${page}"`)
    expect(text).toContain('… and 5 more selected layers.')
  })
})
