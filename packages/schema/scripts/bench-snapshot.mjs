#!/usr/bin/env node
// Schema benchmarks: build, toSnapshot and toSubtreeSnapshot on the 20k- and 50k-node bench
// documents, plus decodeNode against an exact copy of the Phase 2 decoder (interleaved A/B in
// one process, 10 passes per sample, median of 31 samples). Contract budget: decodeNode ≤ +5 %.
//
//   node packages/schema/scripts/bench-snapshot.mjs      (Node >= 22.18)
import {
  decodeNode,
  generateBenchDoc,
  getChildIds,
  nodesTree,
  toSnapshot,
  toSubtreeSnapshot,
} from '../src/index.ts'

// Exact Phase 2 decodeNode (packages/schema/src/nodes.ts before Phase 3), including NODE_KEY reads.
const NODE_KEY = {
  type: 'type',
  name: 'name',
  styles: 'styles',
  text: 'text',
  svg: 'svg',
  assetId: 'assetId',
  assetName: 'assetName',
  locked: 'locked',
  hidden: 'hidden',
  background: 'background',
}
const NODE_TYPES = ['page', 'frame', 'text', 'rect', 'svg', 'image']
function isNodeType(value) {
  return typeof value === 'string' && NODE_TYPES.includes(value)
}
function isStyleValue(v) {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function decodeOld(id, parentId, children, data) {
  const d = isRecord(data) ? data : {}
  const type = isNodeType(d[NODE_KEY.type]) ? d[NODE_KEY.type] : 'frame'
  const styles = {}
  const rawStyles = d[NODE_KEY.styles]
  if (isRecord(rawStyles)) {
    for (const key in rawStyles) {
      const v = rawStyles[key]
      if (isStyleValue(v)) styles[key] = v
    }
  }
  const name = d[NODE_KEY.name]
  const node = { id, type, name: typeof name === 'string' ? name : '', parentId, children, styles }
  const text = d[NODE_KEY.text]
  if (type === 'text') node.text = typeof text === 'string' ? text : ''
  const svg = d[NODE_KEY.svg]
  if (typeof svg === 'string') node.svg = svg
  const assetId = d[NODE_KEY.assetId]
  if (typeof assetId === 'string') node.assetId = assetId
  const assetName = d[NODE_KEY.assetName]
  if (typeof assetName === 'string') node.assetName = assetName
  const locked = d[NODE_KEY.locked]
  if (typeof locked === 'boolean') node.locked = locked
  const hidden = d[NODE_KEY.hidden]
  if (typeof hidden === 'boolean') node.hidden = hidden
  const background = d[NODE_KEY.background]
  if (typeof background === 'string') node.background = background
  return node
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
function time(fn, runs = 5) {
  const out = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    fn()
    out.push(performance.now() - t)
  }
  return median(out)
}

const sizes = [
  ['20k', 40, 500],
  ['50k', 100, 499],
]
const docs = new Map()
const builds = new Map()
for (const [label, artboards, per] of sizes) {
  builds.set(
    label,
    time(
      () => docs.set(label, generateBenchDoc({ artboards, nodesPerArtboard: per, peerId: 1 })),
      3,
    ),
  )
}

// decodeNode A/B first, before toSnapshot warms decodeNode on other inputs.
const decode = new Map()
for (const [label] of sizes) {
  const metas = []
  const stack = [...nodesTree(docs.get(label)).toJSON()]
  while (stack.length) {
    const n = stack.pop()
    metas.push(n)
    for (const c of n.children) stack.push(c)
  }
  const pass = (fn) => () => {
    for (let k = 0; k < 10; k++) for (const m of metas) fn(m.id, null, [], m.meta)
  }
  const now = []
  const old = []
  for (let r = 0; r < 31; r++) {
    if (r % 2) {
      old.push(time(pass(decodeOld), 1) / 10)
      now.push(time(pass(decodeNode), 1) / 10)
    } else {
      now.push(time(pass(decodeNode), 1) / 10)
      old.push(time(pass(decodeOld), 1) / 10)
    }
  }
  decode.set(label, { count: metas.length, now: median(now), old: median(old) })
}

for (const [label] of sizes) {
  const doc = docs.get(label)
  const snap = time(() => toSnapshot(doc))
  const page = getChildIds(doc, null)[0]
  const board = getChildIds(doc, page)[0]
  const sub = time(() => toSubtreeSnapshot(doc, board), 20)
  const d = decode.get(label)
  console.log(
    `${label}: build ${builds.get(label).toFixed(0)} ms, toSnapshot ${snap.toFixed(1)} ms, ` +
      `toSubtreeSnapshot(500) ${sub.toFixed(2)} ms, decodeNode x${d.count} ${d.now.toFixed(2)} ms ` +
      `(Phase 2 decoder ${d.old.toFixed(2)} ms, ${(((d.now - d.old) / d.old) * 100).toFixed(1)}%)`,
  )
}
