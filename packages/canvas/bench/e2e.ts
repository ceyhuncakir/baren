import type { LoroDoc } from 'loro-crdt'
import {
  createComponent,
  createComponentResolver,
  detachInstance,
  createEmptyDoc,
  createInstance,
  createNode,
  deleteNode,
  docGeometry,
  getChildIds,
  getNode,
  getResolvedNode,
  groupNodes,
  loadDoc,
  moveNode,
  setNodeProps,
  setStyle,
  setStylesAt,
  setText,
  setTextAt,
  setTokens,
  transact,
  type DesignNode,
  type StylePatch,
  type StyleValue,
} from '@baren/schema'
import {
  createCanvas,
  type CanvasController,
  type RemotePresence,
  type TransientChange,
} from '../src/index.ts'
import { loadFonts } from './fonts.ts'

/**
 * Deterministic fixture page for the Playwright e2e specs (tests/e2e). Builds a
 * small document, mounts the canvas at a fixed viewport and exposes helpers on
 * `window.__e2e`.
 */

const doc = createEmptyDoc('E2E', { peerId: 1 })
const pageId = getChildIds(doc, null)[0] as string
setTokens(doc, { '--color-brand': { type: 'color', value: '#FFE8E0' } })

const boardA = createNode(doc, {
  type: 'frame',
  parentId: pageId,
  name: 'Board A',
  styles: {
    left: 0,
    top: 0,
    width: 400,
    height: 300,
    backgroundColor: '#FFFFFF',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '20px',
  },
})
const section = createNode(doc, {
  type: 'frame',
  parentId: boardA,
  name: 'Section',
  styles: {
    display: 'flex',
    flexDirection: 'row',
    gap: '8px',
    padding: '8px',
    backgroundColor: 'var(--color-brand)',
  },
})
const title = createNode(doc, {
  type: 'text',
  parentId: section,
  name: 'Title',
  text: 'Hello',
  styles: { fontFamily: 'Inter', fontSize: '16px', lineHeight: '20px', color: '#111111' },
})
const box = createNode(doc, {
  type: 'rect',
  parentId: section,
  name: 'Box',
  styles: { width: 40, height: 20, backgroundColor: '#2F80FF' },
})
const second = createNode(doc, {
  type: 'rect',
  parentId: boardA,
  name: 'Second',
  styles: { width: 120, height: 30, backgroundColor: '#DDDDDD' },
})
const icon = createNode(doc, {
  type: 'svg',
  parentId: boardA,
  name: 'Icon',
  svg:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" onload="window.__pwned=1">' +
    '<script>window.__pwned=2</script><style>body{display:none}</style>' +
    '<rect width="24" height="24" fill="#F04E1E" onclick="window.__pwned=3"/>' +
    '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
    '<image href="https://evil.example/x.png" width="5" height="5"/>' +
    '<a href="javascript:alert(1)"><circle r="2"/></a></svg>',
  styles: { width: 24, height: 24 },
})
const floating = createNode(doc, {
  type: 'rect',
  parentId: boardA,
  name: 'Floating',
  styles: {
    position: 'absolute',
    left: 300,
    top: 200,
    width: 50,
    height: 50,
    backgroundColor: '#00AA00',
  },
})
const boardB = createNode(doc, {
  type: 'frame',
  parentId: pageId,
  name: 'Board B',
  styles: { left: 500, top: 0, width: 300, height: 300, backgroundColor: '#FFFFFF' },
})
const farAway = createNode(doc, {
  type: 'frame',
  parentId: pageId,
  name: 'Far away',
  styles: { left: 20000, top: 20000, width: 300, height: 200, backgroundColor: '#FFFFFF' },
})
createNode(doc, {
  type: 'text',
  parentId: farAway,
  name: 'Far text',
  text: 'far',
  styles: { fontSize: '14px' },
})

// -----------------------------------------------------------------------------
// Phase 3 page: reparenting, rotation, groups, vectors, components
// -----------------------------------------------------------------------------

let seed = 7
const random = (): number => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const page3 = createNode(doc, { type: 'page', parentId: null, name: 'Phase 3' })
const board = (name: string, left: number, top: number, extra: Record<string, StyleValue> = {}) =>
  createNode(doc, {
    type: 'frame',
    parentId: page3,
    name,
    styles: { left, top, width: 400, height: 300, backgroundColor: '#FFFFFF', ...extra },
  })
const rect = (parentId: string, name: string, styles: Record<string, StyleValue>) =>
  createNode(doc, { type: 'rect', parentId, name, styles })
const boardP = board('Board P', 0, 0, { overflow: 'hidden' })
const mover = rect(boardP, 'Mover', {
  position: 'absolute',
  left: 20,
  top: 20,
  width: 60,
  height: 40,
  backgroundColor: '#FF5500',
})
const spin = rect(boardP, 'Spin', {
  position: 'absolute',
  left: 250,
  top: 150,
  width: 100,
  height: 50,
  rotate: '30deg',
  backgroundColor: '#00AAFF',
})
const boardQ = board('Board Q', 500, 0)
const inner = createNode(doc, {
  type: 'frame',
  parentId: boardQ,
  name: 'Inner',
  styles: {
    position: 'absolute',
    left: 200,
    top: 150,
    width: 150,
    height: 100,
    backgroundColor: '#EEEEEE',
  },
})
const boardF = board('Board F', 1000, 0, {
  width: 300,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  padding: '10px',
  gap: '10px',
})
const f1 = rect(boardF, 'F1', { width: 100, height: 30, backgroundColor: '#999999' })
const f2 = rect(boardF, 'F2', { width: 100, height: 30, backgroundColor: '#666666' })
const boardG = board('Board G', 0, 400)
const ga = rect(boardG, 'GA', {
  position: 'absolute',
  left: 20,
  top: 20,
  width: 50,
  height: 50,
  backgroundColor: '#AA00AA',
})
const gb = rect(boardG, 'GB', {
  position: 'absolute',
  left: 120,
  top: 70,
  width: 50,
  height: 50,
  backgroundColor: '#00AA00',
})
const group = groupNodes(doc, [ga, gb], docGeometry(doc), { origin: 'fixture' }) as string
const boardV = board('Board V', 500, 400)
const path = createNode(doc, {
  type: 'vector',
  parentId: boardV,
  name: 'Zigzag',
  styles: {
    position: 'absolute',
    left: 50,
    top: 50,
    width: 200,
    height: 100,
    fill: 'none',
    stroke: '#000000',
    strokeWidth: 4,
  },
  vector: {
    fillRule: 'nonzero',
    subpaths: [
      {
        id: 'sp000001',
        closed: false,
        points: [
          { x: 0, y: 100 },
          { x: 100, y: 0 },
          { x: 200, y: 100 },
        ],
      },
    ],
  },
})
const tri = createNode(doc, {
  type: 'vector',
  parentId: boardV,
  name: 'Triangle',
  styles: {
    position: 'absolute',
    left: 260,
    top: 170,
    width: 100,
    height: 100,
    fill: '#FFAA00',
  },
  vector: {
    fillRule: 'nonzero',
    subpaths: [
      {
        id: 'sp000002',
        closed: true,
        points: [
          { x: 50, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
      },
    ],
  },
})
const card = createNode(doc, {
  type: 'frame',
  parentId: page3,
  name: 'Card',
  styles: {
    left: 1000,
    top: 400,
    width: 200,
    height: 120,
    backgroundColor: '#FFFFFF',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
  },
})
const cardTitle = createNode(doc, {
  type: 'text',
  parentId: card,
  name: 'Title',
  text: 'Card',
  styles: { fontFamily: 'Inter', fontSize: '16px', lineHeight: '20px', color: '#111111' },
})
const cardBar = rect(card, 'Bar', { width: 100, height: 10, backgroundColor: '#7B4DFF' })
createComponent(doc, [card], docGeometry(doc), { origin: 'fixture', random })
const componentKey = getNode(doc, card)?.componentKey as string
const boardI = board('Board I', 0, 800, { width: 600 })
const inst1 = createInstance(
  doc,
  { componentKey, parentId: boardI, styles: { position: 'absolute', left: 20, top: 20 } },
  { origin: 'fixture', random },
)
const inst2 = createInstance(
  doc,
  { componentKey, parentId: boardI, styles: { position: 'absolute', left: 300, top: 20 } },
  { origin: 'fixture', random },
)
const tilt = createNode(doc, {
  type: 'rect',
  parentId: page3,
  name: 'Tilt',
  styles: {
    left: 700,
    top: 800,
    width: 100,
    height: 100,
    rotate: '45deg',
    backgroundColor: '#22AA22',
  },
})
const p3 = {
  page: page3,
  boardP,
  mover,
  spin,
  boardQ,
  inner,
  boardF,
  f1,
  f2,
  boardG,
  group,
  ga,
  gb,
  boardV,
  path,
  tri,
  card,
  cardTitle,
  cardBar,
  componentKey,
  boardI,
  inst1,
  inst2,
  tilt,
}

/** Peer B: a second document synced explicitly with the canvas document. */
let peerB: LoroDoc | null = null
function peer(): LoroDoc {
  if (!peerB) {
    peerB = loadDoc(doc.export({ mode: 'snapshot' }))
    peerB.setPeerId(77)
  }
  return peerB
}
const sync = {
  /** A's changes → B. */
  toB: () => {
    const b = peer()
    b.import(doc.export({ mode: 'update', from: b.oplogVersion() }))
  },
  /** B's changes → A (the canvas). */
  fromB: () => {
    const b = peer()
    doc.import(b.export({ mode: 'update', from: doc.oplogVersion() }))
  },
  bSetStyle: (id: string, key: string, value: StyleValue | null) => {
    const b = peer()
    transact(b, () => setStyle(b, id, key, value), { origin: 'remote' })
  },
  bSetStylesAt: (ref: string, patch: StylePatch) => {
    const b = peer()
    transact(b, () => setStylesAt(b, ref, patch), { origin: 'remote' })
  },
  bSetTextAt: (ref: string, text: string) => {
    const b = peer()
    transact(b, () => setTextAt(b, ref, text), { origin: 'remote' })
  },
  bSetText: (id: string, text: string) => {
    const b = peer()
    transact(b, () => setText(b, id, text), { origin: 'remote' })
  },
}

const events = {
  selection: [] as string[][],
  hover: [] as (string | null)[],
  tool: [] as string[],
  transient: [] as (TransientChange | null)[],
  context: 0,
  textEdit: [] as (string | null)[],
  vectorEdit: [] as (string | null)[],
}

const stage = document.getElementById('stage') as HTMLDivElement
let canvas: CanvasController | null = null
/** Asset id → URL served by the fixture's resolver (tests register blob URLs here). */
const assetUrls = new Map<string, string>()

function remote(fn: (d: LoroDoc) => void): void {
  const peer = loadDoc(doc.export({ mode: 'snapshot' }))
  peer.setPeerId(99)
  fn(peer)
  peer.commit({ origin: 'remote' })
  doc.import(peer.export({ mode: 'update', from: doc.oplogVersion() }))
}

const api = {
  doc,
  pageId,
  ids: { boardA, section, title, box, second, icon, floating, boardB, farAway },
  events,
  ready: (async () => {
    await loadFonts()
    canvas = createCanvas({
      container: stage,
      doc,
      pageId,
      viewport: { x: -50, y: -50, zoom: 1 },
      resolveAsset: (id) => assetUrls.get(id) ?? null,
      onSelectionChange: (ids) => events.selection.push(ids),
      onHoverChange: (id) => events.hover.push(id),
      onToolChange: (t) => events.tool.push(t),
      onTransientChange: (t) => events.transient.push(t),
      onContextMenu: () => {
        events.context++
      },
      onTextEditChange: (id) => events.textEdit.push(id),
      onVectorEditChange: (id) => events.vectorEdit.push(id),
    })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })(),
  canvas: (): CanvasController => {
    if (!canvas) throw new Error('canvas not ready')
    return canvas
  },
  node: (id: string): DesignNode | undefined => getNode(doc, id),
  children: (id: string | null): string[] => getChildIds(doc, id),
  setStyle: (id: string, key: string, value: StyleValue | null) => setStyle(doc, id, key, value),
  setText: (id: string, text: string) => setText(doc, id, text),
  setHidden: (id: string, hidden: boolean) => setNodeProps(doc, id, { hidden }),
  deleteNode: (id: string) => deleteNode(doc, id),
  createRect: (parentId: string, name: string) =>
    createNode(doc, {
      type: 'rect',
      parentId,
      name,
      styles: { width: 10, height: 10, backgroundColor: '#000' },
    }),
  remoteSetText: (id: string, text: string) => remote((d) => setText(d, id, text)),
  remoteInsertText: (id: string, index: number, s: string) =>
    remote((d) => {
      const tree = d.getTree('nodes')
      const node = tree.getNodeByID(id as `${number}@${number}`)
      const t = node?.data.get('text') as { insert(i: number, s: string): void } | undefined
      t?.insert(index, s)
    }),
  remoteSetStyle: (id: string, key: string, value: StyleValue) =>
    remote((d) => setStyle(d, id, key, value)),
  setPresence: (list: RemotePresence[]) => canvas?.setRemotePresence(list),
  elementOf: (id: string): Element | null => stage.querySelector(`[data-nid="${id}"]`),
  assetUrls,
  createNode: (input: Parameters<typeof createNode>[1]) => createNode(doc, input),
  /** A layer created the way an agent's tool call creates it (one `agent:` commit). */
  agentCreate: (input: Parameters<typeof createNode>[1]): string =>
    transact(doc, () => createNode(doc, input), { origin: 'agent:write_html' }),
  /** A style edit the way an agent's tool call makes it. */
  agentSetStyle: (id: string, key: string, value: StyleValue): void =>
    transact(doc, () => setStyle(doc, id, key, value), { origin: 'agent:update_styles' }),
  /** A rename the way an agent's tool call makes it. */
  agentRename: (id: string, name: string): void =>
    transact(doc, () => setNodeProps(doc, id, { name }), { origin: 'agent:rename_nodes' }),
  /** A layer a collaborator created (imported, no origin). */
  remoteCreate: (input: Parameters<typeof createNode>[1]): string => {
    let id = ''
    remote((d) => {
      id = createNode(d, input)
    })
    return id
  },
  p3,
  sync,
  /** Switch to the Phase 3 page at a fixed viewport (world (x, y) at client (x + 50, y + 50)). */
  phase3: async (x = -50, y = -50, zoom = 1) => {
    const c = api.canvas()
    c.setPage(page3)
    c.setViewport({ x, y, zoom })
    // Scenes mount once the viewport settles (140 ms after the last viewport input).
    await new Promise((r) => setTimeout(r, 200))
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      if (c.getStats().pendingWork === 0) break
    }
    c.focus()
  },
  resolved: (ref: string) => getResolvedNode(doc, ref, createComponentResolver(doc)),
  setStylesAt: (ref: string, patch: StylePatch) => setStylesAt(doc, ref, patch),
  group: (ids: string[]) =>
    groupNodes(doc, ids, api.canvas().geometry(), { origin: 'editor:group' }),
  makeComponent: (ids: string[]) =>
    createComponent(doc, ids, api.canvas().geometry(), { origin: 'editor:component', random }),
  makeInstance: (key: string, parentId: string, styles: Record<string, StyleValue>) =>
    createInstance(
      doc,
      { componentKey: key, parentId, styles },
      { origin: 'editor:insert', random },
    ),
  canUndo: () => api.canvas().canUndo(),
  detach: (id: string) => detachInstance(doc, id, { origin: 'editor:detach' }),
  moveNode: (id: string, parentId: string, index?: number) =>
    transact(doc, () => moveNode(doc, id, parentId, index), { origin: 'editor:layers' }),
}

declare global {
  interface Window {
    __e2e: typeof api
    __pwned?: number
  }
}
window.__e2e = api
