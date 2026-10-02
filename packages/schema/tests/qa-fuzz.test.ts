/**
 * QA (Phase 3): seeded random sequences of the new helpers on one peer (invariants hold after
 * every step, every step is one undo step) and on two peers editing concurrently (helpers never
 * crash on states produced by concurrent edits; both peers converge to identical snapshots,
 * resolved instances and HTML).
 */
import { describe, expect, it } from 'vitest'
import { UndoManager, type LoroDoc } from 'loro-crdt'
import {
  SchemaError,
  createComponent,
  createComponentResolver,
  createInstance,
  createNode,
  detachInstance,
  docGeometry,
  duplicateNodes,
  editVector,
  getChildIds,
  getNode,
  groupNodes,
  pasteClipboard,
  removeNodes,
  renderHtml,
  reparentNodes,
  resetOverrides,
  rotateNodes,
  serializeClipboard,
  setPropsAt,
  setRotation,
  setStylesAt,
  setTextAt,
  toRenderSubtree,
  toSnapshot,
  ungroupNodes,
  wrapInFrame,
  type DesignNode,
} from '../src/index.ts'
import { docWithPage, seeded, sync, twoPeers } from './helpers.ts'
import { checkInvariants } from './invariants.ts'

type Rng = () => number

function pick<T>(rng: Rng, xs: readonly T[]): T | undefined {
  return xs.length === 0 ? undefined : xs[Math.floor(rng() * xs.length)]
}

function allNodes(doc: LoroDoc): DesignNode[] {
  return Object.values(toSnapshot(doc).nodes)
}

/** Real and virtual refs on the first page. */
function refs(doc: LoroDoc): string[] {
  const out: string[] = []
  const r = createComponentResolver(doc)
  for (const n of allNodes(doc)) {
    if (n.type === 'page') continue
    out.push(n.id)
    if (n.type === 'instance') {
      const exp = r.expandInstance(n.id)
      if (exp) for (const id of Object.keys(exp.nodes)) if (id !== n.id) out.push(id)
    }
  }
  return out
}

function seedDoc(doc: LoroDoc, pageId: string): void {
  const board = createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name: 'Board',
    styles: { left: 0, top: 0, width: 800, height: 600, backgroundColor: '#FFFFFF' },
  })
  const flex = createNode(doc, {
    type: 'frame',
    parentId: board,
    name: 'Flex',
    styles: {
      position: 'absolute',
      left: 400,
      top: 20,
      width: 300,
      height: 200,
      display: 'flex',
      gap: 8,
    },
  })
  for (let i = 0; i < 4; i++) {
    createNode(doc, {
      type: 'rect',
      parentId: i % 2 === 0 ? board : flex,
      name: `R${i}`,
      styles: {
        ...(i % 2 === 0 ? { position: 'absolute', left: 20 + i * 60, top: 40 + i * 20 } : {}),
        width: 40,
        height: 30,
        backgroundColor: '#3366FF',
      },
    })
  }
  createNode(doc, {
    type: 'text',
    parentId: board,
    name: 'T',
    text: 'Hello',
    styles: { position: 'absolute', left: 30, top: 300, width: 100, height: 20 },
  })
  createNode(doc, {
    type: 'vector',
    parentId: board,
    name: 'V',
    styles: { position: 'absolute', left: 200, top: 300, width: 100, height: 100 },
    vector: {
      fillRule: 'nonzero',
      subpaths: [
        {
          id: 'fz000001',
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 100 },
            { x: 100, y: 0 },
          ],
        },
      ],
    },
  })
  const card = createNode(doc, {
    type: 'frame',
    parentId: pageId,
    name: 'Card',
    styles: { left: 900, top: 0, width: 200, height: 100, backgroundColor: '#EEEEEE' },
  })
  createNode(doc, {
    type: 'text',
    parentId: card,
    name: 'Label',
    text: 'Card',
    styles: { position: 'absolute', left: 8, top: 8, width: 80, height: 20 },
  })
  createComponent(doc, [card], docGeometry(doc), { random: seeded(77) })
  createInstance(doc, {
    componentKey: getNode(doc, card)!.componentKey!,
    parentId: board,
    styles: { position: 'absolute', left: 40, top: 420 },
  })
}

/** One random editing step. Returns a label (for failure messages). */
function randomStep(doc: LoroDoc, pageId: string, rng: Rng): string {
  const geo = docGeometry(doc)
  const all = refs(doc)
  const real = all.filter((r) => !r.includes('/'))
  const virtual = all.filter((r) => r.includes('/'))
  const containers = allNodes(doc).filter((n) => n.type === 'frame' || n.type === 'group')
  const keys = allNodes(doc)
    .filter((n) => n.type === 'frame' && n.componentKey)
    .map((n) => n.componentKey as string)
  const some = (n: number): string[] => {
    const out = new Set<string>()
    for (let i = 0; i < n; i++) {
      const r = pick(rng, real)
      if (r) out.add(r)
    }
    return [...out]
  }
  const op = Math.floor(rng() * 16)
  try {
    switch (op) {
      case 0:
        groupNodes(doc, some(2), geo, { origin: 'fuzz:group' })
        return 'group'
      case 1: {
        const groups = allNodes(doc).filter((n) => n.type === 'group')
        const g = pick(rng, groups)
        if (g) ungroupNodes(doc, [g.id], geo, { origin: 'fuzz:ungroup' })
        return 'ungroup'
      }
      case 2: {
        const target = pick(rng, containers)
        const moving = some(1)
        if (target)
          reparentNodes(
            doc,
            moving.map((id) => ({ id })),
            { parentId: rng() < 0.2 ? pageId : target.id, index: Math.floor(rng() * 3) },
            geo,
            { origin: 'fuzz:reparent' },
          )
        return 'reparent'
      }
      case 3:
        rotateNodes(doc, some(2), Math.round(rng() * 360 - 180), geo, { origin: 'fuzz:rotate' })
        return 'rotate'
      case 4:
        setRotation(doc, [pick(rng, all) ?? ''].filter(Boolean), Math.round(rng() * 90), geo, {
          origin: 'fuzz:setRotation',
        })
        return 'setRotation'
      case 5:
        createComponent(doc, some(1), geo, { origin: 'fuzz:component', random: rng })
        return 'createComponent'
      case 6: {
        const key = pick(rng, keys)
        const parent = pick(rng, containers)
        if (key && parent)
          createInstance(
            doc,
            {
              componentKey: key,
              parentId: parent.id,
              styles: { position: 'absolute', left: 10, top: 10 },
            },
            { origin: 'fuzz:instance', random: rng },
          )
        return 'createInstance'
      }
      case 7: {
        const v = pick(rng, virtual)
        if (v) setStylesAt(doc, v, { backgroundColor: '#FF00FF', opacity: 0.5 }, { origin: 'fuzz' })
        return 'override styles'
      }
      case 8: {
        const v = pick(rng, virtual)
        if (v && createComponentResolver(doc).resolveNode(v)?.type === 'text')
          setTextAt(doc, v, `o${Math.floor(rng() * 100)}`, { origin: 'fuzz' })
        else if (v) setPropsAt(doc, v, { hidden: rng() < 0.5 }, { origin: 'fuzz' })
        return 'override text/hidden'
      }
      case 9: {
        const inst = pick(
          rng,
          allNodes(doc).filter((n) => n.type === 'instance'),
        )
        if (inst) detachInstance(doc, inst.id, { origin: 'fuzz:detach' })
        return 'detach'
      }
      case 10: {
        const inst = pick(
          rng,
          allNodes(doc).filter((n) => n.type === 'instance'),
        )
        if (inst) resetOverrides(doc, inst.id, { origin: 'fuzz:reset' })
        return 'reset'
      }
      case 11:
        duplicateNodes(doc, some(2), geo, { origin: 'fuzz:duplicate' })
        return 'duplicate'
      case 12: {
        const src = some(2)
        const target = pick(rng, containers)
        const payload =
          src.length > 0 ? serializeClipboard(doc, src, { geo, fileId: 'f', pageId }) : null
        if (payload && target)
          pasteClipboard(doc, payload, {
            parentId: target.id,
            geo,
            translate: { dx: 24, dy: 24 },
            origin: 'fuzz:paste',
          })
        return 'paste'
      }
      case 13: {
        const vectors = allNodes(doc).filter((n) => n.type === 'vector')
        const v = pick(rng, vectors)
        const sp = v?.vector?.subpaths[0]
        if (v && sp)
          editVector(doc, v.id, [
            {
              kind: 'set',
              subpathId: sp.id,
              index: Math.floor(rng() * sp.points.length),
              point: { x: Math.round(rng() * 100), y: Math.round(rng() * 100) },
            },
            { kind: 'closed', subpathId: sp.id, closed: rng() < 0.5 },
          ])
        return 'vector'
      }
      case 14:
        wrapInFrame(doc, some(2), geo, { origin: 'fuzz:wrap' })
        return 'wrap'
      default:
        removeNodes(doc, some(1), geo, { origin: 'fuzz:remove' })
        return 'remove'
    }
  } catch (err) {
    // Cycles are refused by design; anything else is a bug.
    if (err instanceof SchemaError && err.code === 'cycle') return `op ${op} refused (cycle)`
    throw new Error(`op ${op} threw: ${(err as Error).message}`, { cause: err })
  }
}

/**
 * Invariant violations, minus the documented exception (contract 2.7.2, model notes): keys
 * inside nested mains address their own instances' overrides and are never re-keyed, so a
 * main may repeat a key between nested mains (copies of one main nested twice) or between a
 * nested main and one of its own nodes (a copy of the main nested in it).
 */
function violations(doc: LoroDoc): string[] {
  const snap = toSnapshot(doc)
  return checkInvariants(doc, { groupTolerance: 1 }).filter((p) => {
    const m = /^nodeKey (\S+) repeats in main (\S+)$/.exec(p)
    if (!m) return true
    const [, key, mainId] = m as unknown as [string, string, string]
    const owners: string[] = []
    const walk = (id: string, nested: string | null): void => {
      const n = snap.nodes[id] as DesignNode
      const inner = id !== mainId && n.type === 'frame' && n.componentKey ? id : nested
      if (id !== mainId && n.nodeKey === key) owners.push(inner ?? '')
      for (const c of n.children) walk(c, inner)
    }
    walk(mainId, null)
    const direct = owners.filter((o) => o === '').length
    const nested = owners.filter((o) => o !== '')
    return !(direct <= 1 && new Set(nested).size === nested.length)
  })
}

function rendered(doc: LoroDoc): { snap: unknown; instances: unknown; html: string } {
  const snap = toSnapshot(doc)
  const r = createComponentResolver(doc)
  const pageRoots = snap.pageIds.flatMap((p) => getChildIds(doc, p))
  return {
    snap,
    instances: Object.values(snap.nodes)
      .filter((n) => n.type === 'instance')
      .map((n) => n.id)
      .sort()
      .map((id) => toRenderSubtree(doc, id, r)),
    html: renderHtml(doc, pageRoots, { includeIds: true }),
  }
}

// Deterministic but CPU-heavy (5–7 s each): an explicit timeout keeps them from failing on a
// busy machine.
describe('QA fuzz', () => {
  it('one peer: 300 random steps keep every invariant and each step undoes in one step', () => {
    for (const seed of [1, 2, 3]) {
      const rng = seeded(seed * 1000 + 7)
      const { doc, pageId } = docWithPage('Fuzz', 1)
      seedDoc(doc, pageId)
      doc.commit()
      const undo = new UndoManager(doc, { mergeInterval: 0 })
      for (let step = 0; step < 100; step++) {
        const before = JSON.stringify(rendered(doc))
        const label = randomStep(doc, pageId, rng)
        doc.commit()
        const problems = violations(doc)
        expect(problems, `seed ${seed} step ${step} (${label})`).toEqual([])
        // Every 10th step: undo restores the previous render exactly, redo re-applies.
        if (step % 10 === 0 && JSON.stringify(rendered(doc)) !== before) {
          const after = JSON.stringify(rendered(doc))
          undo.undo()
          // Undo of a delete re-creates nodes under new ids: compare the HTML without ids.
          const strip = (s: string) => s.replace(/data-node-id="[^"]*"/g, '')
          expect(strip(rendered(doc).html), `seed ${seed} step ${step} (${label}): undo`).toBe(
            strip((JSON.parse(before) as { html: string }).html),
          )
          undo.redo()
          expect(strip(rendered(doc).html), `seed ${seed} step ${step} (${label}): redo`).toBe(
            strip((JSON.parse(after) as { html: string }).html),
          )
        }
      }
    }
  }, 60_000)

  it('two peers: random concurrent steps never crash and always converge', () => {
    for (const seed of [11, 12, 13, 14]) {
      const rngA = seeded(seed)
      const rngB = seeded(seed + 500)
      const { a, b, pageId } = twoPeers()
      seedDoc(a, pageId)
      a.commit()
      sync(a, b)
      for (let round = 0; round < 25; round++) {
        const steps = 1 + Math.floor(rngA() * 3)
        for (let i = 0; i < steps; i++) randomStep(a, pageId, rngA)
        for (let i = 0; i < steps; i++) randomStep(b, pageId, rngB)
        a.commit()
        b.commit()
        sync(a, b)
        expect(rendered(a), `seed ${seed} round ${round}`).toEqual(rendered(b))
      }
    }
  }, 60_000)
})
