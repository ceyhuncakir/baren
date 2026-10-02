#!/usr/bin/env node
// Writes parity.loro (a Loro snapshot written by loro-crdt through the
// @baren/schema helpers) and, next to it, exactly what the JS side prints
// for it:
//   parity.snapshot.txt   JSON.stringify(toSnapshot(doc), null, 2)
//   parity.subtree.txt    JSON.stringify(toSubtreeSnapshot(doc, board), null, 2)
// (.txt so formatters leave the exact JSON.stringify bytes alone)
// crates/core/tests/fixture_compat.rs asserts the Rust core prints the same
// bytes. The document exercises every decoding rule: two peers merging
// concurrent edits of the same mergeable containers, moves, deletes, text
// diffs, unicode, extreme numbers and raw values the helpers would never write.
//
// Phase 3 (docs/phase3/contract.md §4.11) adds parity3.loro with groups (one
// rotated), vectors (lines + curves, closed + open), a main with a nested
// instance, an instance with root/child/nested overrides (incl. null), a
// deleted main with a live instance, an unresolved instance and the registry,
// edited concurrently by two peers. Next to it:
//   parity3.snapshot.txt  toSnapshot
//   parity3.render.txt    { roots: [toRenderSubtree(doc, root) …] }
//   parity3.paths.txt     { <vector id>: vectorToPathD(vector) }
//   parity3.html.txt      { <root id>: renderHtml(doc, [root], { includeIds: true }) }
//
//   node crates/core/tests/fixtures/make-parity.mjs     (Node >= 22.18)
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LoroMap, LORO_VERSION } from 'loro-crdt'
import {
  createComponent,
  createEmptyDoc,
  createInstance,
  createNode,
  deleteNode,
  docGeometry,
  exportSnapshot,
  getChildIds,
  getNode,
  loadDoc,
  moveNode,
  nodesTree,
  renderHtml,
  setNodeProps,
  setPropsAt,
  setStyles,
  setStylesAt,
  setText,
  setTextAt,
  setTokens,
  tokensMap,
  toRenderSubtree,
  toSnapshot,
  toSubtreeSnapshot,
  transact,
  vectorToPathD,
} from '../../../../packages/schema/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))

const a = createEmptyDoc('Parity ✦ <file> "quoted"', { peerId: 11 })
const page = getChildIds(a, null)[0]
const ids = {}

transact(
  a,
  () => {
    ids.board = createNode(a, {
      type: 'frame',
      parentId: page,
      name: 'Board',
      styles: {
        left: -120.5,
        top: 0,
        width: 1440,
        height: 900,
        display: 'flex',
        gap: '12px',
        opacity: 0.25,
        zIndex: -0,
        backgroundColor: 'var(--color-background)',
      },
    })
    ids.title = createNode(a, {
      type: 'text',
      parentId: ids.board,
      name: 'Title',
      text: 'Hello 👋 <b>"world"</b> & ünïcödé — 你好\nsecond line',
      styles: { fontSize: '32px', color: 'var(--color-primary)' },
    })
    ids.row = createNode(a, {
      type: 'frame',
      parentId: ids.board,
      name: 'Row',
      styles: { display: 'flex', flexDirection: 'row' },
    })
    ids.rect = createNode(a, {
      type: 'rect',
      parentId: ids.row,
      name: 'Rect',
      styles: { width: 1e21, height: 0.1 + 0.2, borderRadius: 1.5e-7, top: 2 ** 60 },
    })
    ids.icon = createNode(a, {
      type: 'svg',
      parentId: ids.row,
      svg: '<svg viewBox="0 0 1 1"><script>alert(1)</script><path d="M0 0"/></svg>',
    })
    ids.image = createNode(a, {
      type: 'image',
      parentId: ids.row,
      assetId: 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
      assetName: 'dolomites-dawn.jpg',
      styles: {
        width: '64px',
        height: '64px',
        objectFit: 'cover',
        backgroundImage:
          'url("baren-asset://af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262")',
      },
    })
    ids.empty = createNode(a, { type: 'text', parentId: ids.row })
    ids.second = createNode(a, {
      type: 'page',
      parentId: null,
      name: 'Second',
      background: '#FFFFFF',
      index: 0,
    })
    setTokens(a, {
      '--color-primary': { type: 'color', value: '#141414', description: 'Ink' },
      '--color-background': { type: 'color', value: '#FFFFFF' },
      '--space-2': { type: 'spacing', value: 8 },
      '--gone': { type: 'other', value: 'x' },
    })
  },
  { origin: 'parity' },
)

// Peer b forks, both peers edit the same containers concurrently, then merge.
const b = loadDoc(exportSnapshot(a))
b.setPeerId(22)
transact(a, () => {
  setStyles(a, ids.title, { color: '#FF0000', fontWeight: 600 })
  setText(a, ids.title, 'Hello 👋 <b>"world"</b> & ünïcödé — 你好!!\nsecond line')
  moveNode(a, ids.rect, ids.board, 0)
})
transact(b, () => {
  setStyles(b, ids.title, { lineHeight: '40px', fontSize: null })
  setText(b, ids.title, 'Hey 👋 <b>"world"</b> & ünïcödé — 你好\nsecond line')
  setTokens(b, {
    '--gone': null,
    '--color-primary': { type: 'color', value: '#141414' },
  })
  deleteNode(b, ids.icon)
  setNodeProps(b, ids.row, { name: null, hidden: false, locked: true })
})
a.import(b.export({ mode: 'update' }))

// Raw values the helpers never write, to pin the decoding rules.
transact(a, () => {
  const raw = nodesTree(a).getNodeByID(ids.board).createNode()
  raw.data.set('type', 'widget') // unknown type → frame
  raw.data.set('name', 42) // non-string name → ''
  raw.data.set('hidden', 'yes') // non-boolean → omitted
  raw.data.set('text', 'ignored on a frame')
  const styles = raw.data.ensureMergeableMap('styles')
  styles.set('ok', 'yes')
  styles.set('flag', true) // non-scalar → dropped
  styles.set('nan', Number.NaN) // non-finite → dropped
  styles.setContainer('nested', new LoroMap()) // container → dropped
  const bare = nodesTree(a).getNodeByID(ids.board).createNode()
  bare.data.set('type', 'text') // text node without a text container → ''
  const tokens = tokensMap(a)
  tokens.set('--raw', 'not a map') // skipped
  tokens.ensureMergeableMap('--untyped').set('value', 0.5) // type → 'other'
  tokens.ensureMergeableMap('--boolean').set('value', true) // skipped
})

const bytes = exportSnapshot(a)
const reloaded = loadDoc(bytes)
writeFileSync(join(here, 'parity.loro'), bytes)
writeFileSync(join(here, 'parity.snapshot.txt'), JSON.stringify(toSnapshot(reloaded), null, 2))
writeFileSync(
  join(here, 'parity.subtree.txt'),
  JSON.stringify(toSubtreeSnapshot(reloaded, ids.board), null, 2),
)
console.log(
  `wrote parity.loro (${bytes.byteLength} bytes) and parity.{snapshot,subtree}.txt with loro-crdt ${LORO_VERSION()}`,
)

// ---------------------------------------------------------------------------
// Phase 3 document
// ---------------------------------------------------------------------------

/** mulberry32 (deterministic keys). */
function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = seeded(2026)
const p3 = createEmptyDoc('Phase 3 parity', { peerId: 31 })
const page3 = getChildIds(p3, null)[0]
const p3ids = {}
const geo = () => docGeometry(p3)
const key = (id) => getNode(p3, id).nodeKey

transact(
  p3,
  () => {
    setTokens(p3, { '--ink': { type: 'color', value: '#141414' } })
    // Badge main (nested inside Card through an instance).
    p3ids.badge = createNode(p3, {
      type: 'frame',
      parentId: page3,
      name: 'Badge',
      styles: {
        left: 0,
        top: 600,
        width: 60,
        height: 20,
        display: 'flex',
        backgroundColor: '#2F80FF',
        rotate: '3deg',
      },
    })
    p3ids.badgeText = createNode(p3, {
      type: 'text',
      parentId: p3ids.badge,
      name: 'Label',
      text: 'New',
      styles: { color: '#FFFFFF' },
    })
    p3ids.badgeDot = createNode(p3, {
      type: 'rect',
      parentId: p3ids.badge,
      name: 'Dot',
      styles: { width: 6, height: 6 },
    })
    createComponent(p3, [p3ids.badge], geo(), { random })
    // Card main.
    p3ids.card = createNode(p3, {
      type: 'frame',
      parentId: page3,
      name: 'Card',
      styles: {
        left: 0,
        top: 0,
        width: 240,
        height: 160,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--ink)',
      },
    })
    p3ids.title = createNode(p3, {
      type: 'text',
      parentId: p3ids.card,
      name: 'Title',
      text: 'Card title',
      styles: { fontSize: '24px', color: '#FFFFFF' },
    })
    p3ids.icon = createNode(p3, {
      type: 'rect',
      parentId: p3ids.card,
      name: 'Icon',
      styles: { width: 16, height: 16, backgroundColor: 'red', borderRadius: 4 },
    })
    p3ids.body = createNode(p3, {
      type: 'frame',
      parentId: p3ids.card,
      name: 'Body',
      styles: { padding: 4 },
    })
    p3ids.label = createNode(p3, {
      type: 'text',
      parentId: p3ids.body,
      name: 'Label',
      text: 'Body text',
      styles: {},
    })
    p3ids.photo = createNode(p3, {
      type: 'image',
      parentId: p3ids.card,
      name: 'Photo',
      assetId: 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
      styles: { width: 32, height: 32, objectFit: 'cover' },
    })
    p3ids.glyph = createNode(p3, {
      type: 'vector',
      parentId: p3ids.card,
      name: 'Glyph',
      styles: { width: 40, height: 20, fill: 'none', stroke: '#000000', strokeWidth: 1.5 },
      vector: {
        fillRule: 'evenodd',
        subpaths: [
          {
            id: 'closed01',
            closed: true,
            points: [
              { x: 0, y: 0 },
              { x: 20, y: 0, out: [5, 5] },
              { x: 20, y: 20, in: [0, -5], mode: 'smooth' },
            ],
          },
          {
            id: 'open0001',
            closed: false,
            points: [
              { x: 25.5, y: 1 / 3 },
              { x: 40, y: 20 },
            ],
          },
        ],
      },
    })
    createComponent(p3, [p3ids.card], geo(), { random })
    p3ids.cardKey = getNode(p3, p3ids.card).componentKey
    p3ids.badgeKey = getNode(p3, p3ids.badge).componentKey
    p3ids.nested = createInstance(
      p3,
      { componentKey: p3ids.badgeKey, parentId: p3ids.card, styles: { flexShrink: 0 } },
      { random },
    )
    // Overrides stored on the nested instance inside the Card main.
    setTextAt(p3, `${p3ids.nested}/${key(p3ids.badgeText)}`, 'Hot')
    // Ghost main: deleted below, its instance keeps rendering from retained data.
    p3ids.ghost = createNode(p3, {
      type: 'frame',
      parentId: page3,
      name: 'Ghost',
      styles: { left: 400, top: 600, width: 30, height: 30, backgroundColor: '#999' },
    })
    p3ids.ghostChild = createNode(p3, { type: 'text', parentId: p3ids.ghost, text: 'Boo' })
    createComponent(p3, [p3ids.ghost], geo(), { random })
    p3ids.ghostKey = getNode(p3, p3ids.ghost).componentKey
    // Board with groups, vectors and instances.
    p3ids.board = createNode(p3, {
      type: 'frame',
      parentId: page3,
      name: 'Board',
      styles: { left: 500, top: 0, width: 800, height: 600, backgroundColor: '#FFFFFF' },
    })
    p3ids.group = createNode(p3, {
      type: 'group',
      parentId: p3ids.board,
      name: 'Group',
      styles: { position: 'absolute', left: 10, top: 10, width: 120, height: 60 },
    })
    createNode(p3, {
      type: 'rect',
      parentId: p3ids.group,
      styles: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 60,
        height: 60,
        backgroundColor: '#F04E1E',
      },
    })
    createNode(p3, {
      type: 'rect',
      parentId: p3ids.group,
      styles: { position: 'absolute', left: 60, top: 20, width: 60, height: 40, rotate: '15deg' },
    })
    p3ids.rotatedGroup = createNode(p3, {
      type: 'group',
      parentId: p3ids.board,
      name: 'Rotated',
      styles: {
        position: 'absolute',
        left: 200,
        top: 10,
        width: 50,
        height: 50,
        rotate: '-30deg',
        opacity: 0.5,
      },
    })
    createNode(p3, {
      type: 'rect',
      parentId: p3ids.rotatedGroup,
      styles: { position: 'absolute', left: 0, top: 0, width: 50, height: 50 },
    })
    p3ids.boardVector = createNode(p3, {
      type: 'vector',
      parentId: p3ids.board,
      name: 'Line',
      styles: {
        position: 'absolute',
        left: 300,
        top: 300,
        width: 100,
        height: 1,
        stroke: 'var(--ink)',
        rotate: 45,
        overflow: 'hidden',
      },
      vector: {
        fillRule: 'nonzero',
        subpaths: [
          {
            id: 'line0001',
            closed: false,
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0.0004 },
            ],
          },
        ],
      },
    })
    p3ids.instance = createInstance(
      p3,
      {
        componentKey: p3ids.cardKey,
        parentId: p3ids.board,
        styles: { position: 'absolute', left: 400, top: 40, width: 260, rotate: '10deg' },
      },
      { random },
    )
    p3ids.ghostInstance = createInstance(
      p3,
      {
        componentKey: p3ids.ghostKey,
        parentId: p3ids.board,
        styles: { position: 'absolute', left: 20, top: 400 },
      },
      { random },
    )
    p3ids.unresolved = createNode(p3, {
      type: 'instance',
      parentId: p3ids.board,
      componentKey: 'zzzzzzzzzzzzzzzz',
      styles: { position: 'absolute', left: 100, top: 400 },
    })
  },
  { origin: 'parity' },
)

// Root, child, nested (incl. null) overrides.
transact(p3, () => {
  const inst = p3ids.instance
  setStylesAt(p3, inst, { backgroundColor: '#222222', opacity: 0.9 })
  setTextAt(p3, `${inst}/${key(p3ids.title)}`, 'Instance title')
  setStylesAt(p3, `${inst}/${key(p3ids.icon)}`, { backgroundColor: 'green', borderRadius: null })
  setPropsAt(p3, `${inst}/${key(p3ids.label)}`, { hidden: true })
  setPropsAt(p3, `${inst}/${key(p3ids.photo)}`, { assetId: '0'.repeat(64), assetName: 'zero.png' })
  setStylesAt(p3, `${inst}/${key(p3ids.nested)}/${key(p3ids.badgeDot)}`, {
    backgroundColor: 'yellow',
  })
  setStylesAt(p3, `${inst}/${key(p3ids.nested)}`, { opacity: 0.5, flexShrink: 1 })
})

// A second peer edits concurrently: main edits and more overrides.
const q3 = loadDoc(exportSnapshot(p3))
q3.setPeerId(32)
transact(p3, () => {
  setStyles(p3, p3ids.icon, { width: 20 })
  setText(p3, p3ids.badgeText, 'NEW')
})
transact(q3, () => {
  setStylesAt(q3, `${p3ids.instance}/${key(p3ids.icon)}`, { height: 18 })
  setStyles(q3, p3ids.title, { fontWeight: 600 })
  deleteNode(q3, p3ids.ghost)
})
p3.import(q3.export({ mode: 'update' }))

// Raw values the helpers never write.
transact(p3, () => {
  const tree = nodesTree(p3)
  const instData = tree.getNodeByID(p3ids.instance).data
  const junk = instData.get('overrides').ensureMergeableMap('junkjunk00')
  junk.set('text', 42) // non-string → dropped
  junk.set('hidden', 'yes') // non-boolean → dropped (entry empty → omitted)
  const vec = tree.getNodeByID(p3ids.glyph).data.get('vector').get('subpaths')
  vec.ensureMergeableMap('emptyone').set('order', 9) // no points → skipped
})

const bytes3 = exportSnapshot(p3)
const re3 = loadDoc(bytes3)
writeFileSync(join(here, 'parity3.loro'), bytes3)
writeFileSync(join(here, 'parity3.snapshot.txt'), JSON.stringify(toSnapshot(re3), null, 2))
const roots = [
  p3ids.board,
  p3ids.card,
  `${p3ids.instance}/${key(p3ids.body)}`,
  `${p3ids.instance}/${key(p3ids.nested)}`,
]
writeFileSync(
  join(here, 'parity3.render.txt'),
  JSON.stringify({ roots: roots.map((r) => toRenderSubtree(re3, r)) }, null, 2),
)
const paths = {}
for (const id of [p3ids.glyph, p3ids.boardVector])
  paths[id] = vectorToPathD(getNode(re3, id).vector)
writeFileSync(join(here, 'parity3.paths.txt'), JSON.stringify(paths, null, 2))
const html = {}
for (const r of [p3ids.board, p3ids.card, page3, `${p3ids.instance}/${key(p3ids.body)}`]) {
  html[r] = renderHtml(re3, [r], { includeIds: true })
}
writeFileSync(join(here, 'parity3.html.txt'), JSON.stringify(html, null, 2))
console.log(
  `wrote parity3.loro (${bytes3.byteLength} bytes) and parity3.{snapshot,render,paths,html}.txt`,
)
