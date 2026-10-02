import type { LoroDoc, LoroTreeNode } from 'loro-crdt'
import { createEmptyDoc, nodesTree, transact } from './doc.ts'
import { writeRegistry } from './graph.ts'
import { newComponentKey, newNodeKey, newSubpathId } from './ids.ts'
import { writeNodeData } from './nodes.ts'
import type { NodeType, Styles, VectorPoint } from './types.ts'

export interface BenchDocOptions {
  artboards: number
  /** Layers inside each artboard (not counting the artboard itself). */
  nodesPerArtboard: number
  name?: string
  /** PRNG seed — the same options always produce the same document content. */
  seed?: number
  /** Artboards per row. Default: ceil(sqrt(artboards)). */
  columns?: number
  artboardWidth?: number
  artboardHeight?: number
  /** Fixed Loro peer id so node ids are reproducible too. */
  peerId?: bigint | number | `${number}`
  /**
   * Phase 3 preset: `mains` 12-node main components on a second page ("Components"), and every
   * `everyNth` leaf an instance of one of them (every other instance overrides its title).
   * Default off (the default output is unchanged).
   */
  components?: { mains: number; everyNth: number }
  /** Phase 3 preset: every `everyNth` leaf an 8-point closed vector. Default off. */
  vectors?: { everyNth: number }
}

/** Nodes in one bench main component (frame + 11 descendants). */
export const BENCH_MAIN_NODE_COUNT = 12

/** Total node count `generateBenchDoc` produces (page + artboards + layers). */
export function benchDocNodeCount(
  options: Pick<BenchDocOptions, 'artboards' | 'nodesPerArtboard' | 'components'>,
): number {
  const mains = Math.max(0, Math.trunc(options.components?.mains ?? 0))
  const components = mains > 0 ? 1 + mains * BENCH_MAIN_NODE_COUNT : 0
  return 1 + options.artboards * (1 + options.nodesPerArtboard) + components
}

interface BenchMain {
  key: string
  id: string
  titleKey: string
}

interface Phase3Ctx {
  leaf: number
  mains: BenchMain[]
  instanceNth: number
  vectorNth: number
}

/** A 12-node card main: frame > title, subtitle, row(4 rects), badge(text), divider, footer. */
function buildMain(page: LoroTreeNode, m: number, rand: () => number): BenchMain {
  const key = newComponentKey(rand)
  const root = page.createNode()
  writeNodeData(root.data, {
    type: 'frame',
    name: `Card ${m + 1}`,
    componentKey: key,
    styles: {
      left: m * 280,
      top: 0,
      width: 200,
      height: 120,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '12px',
      borderRadius: '8px',
      backgroundColor: '#FFFFFF',
    },
  })
  const child = (
    parent: LoroTreeNode,
    input: Parameters<typeof writeNodeData>[1],
  ): LoroTreeNode => {
    const n = parent.createNode()
    writeNodeData(n.data, { ...input, nodeKey: newNodeKey(rand) })
    return n
  }
  const textStyles: Styles = {
    fontFamily: 'Inter',
    fontSize: '13px',
    lineHeight: '18px',
    color: '#141414',
  }
  const title = child(root, {
    type: 'text',
    name: 'Title',
    text: `Card ${m + 1}`,
    styles: textStyles,
  })
  child(root, {
    type: 'text',
    name: 'Subtitle',
    text: 'Subtitle',
    styles: { ...textStyles, color: '#666666' },
  })
  const row = child(root, { type: 'frame', name: 'Row', styles: { display: 'flex', gap: '4px' } })
  for (let i = 0; i < 4; i++) {
    child(row, {
      type: 'rect',
      name: `Dot ${i + 1}`,
      styles: {
        width: '16px',
        height: '16px',
        borderRadius: '8px',
        backgroundColor: pick(PALETTE, rand()),
      },
    })
  }
  const badge = child(root, {
    type: 'frame',
    name: 'Badge',
    styles: {
      display: 'flex',
      padding: '2px 6px',
      borderRadius: '4px',
      backgroundColor: '#2F80FF',
    },
  })
  child(badge, {
    type: 'text',
    name: 'Label',
    text: 'New',
    styles: { ...textStyles, color: '#FFFFFF' },
  })
  child(root, {
    type: 'rect',
    name: 'Divider',
    styles: { height: '1px', backgroundColor: '#E5E5E5' },
  })
  child(root, { type: 'text', name: 'Footer', text: 'Footer', styles: textStyles })
  return { key, id: root.id, titleKey: title.data.get('nodeKey') as string }
}

/** An 8-point closed star, 32 × 32. */
function starPoints(): VectorPoint[] {
  const out: VectorPoint[] = []
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4
    const r = i % 2 === 0 ? 16 : 7
    out.push({
      x: Math.round((16 + r * Math.sin(a)) * 100) / 100,
      y: Math.round((16 - r * Math.cos(a)) * 100) / 100,
    })
  }
  return out
}

const ARTBOARD_GAP = 160
/** Max children per section before a new section frame starts. */
const SECTION_SIZE = 8
const PALETTE = ['#141414', '#2F80FF', '#F04E1E', '#E5E5E5', '#F7F7F7', '#666666']
const WORDS = ['Design', 'Layers', 'Canvas', 'Tokens', 'Export', 'Invite', 'Frames', 'Recent']

/** mulberry32: tiny, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(items: readonly T[], r: number): T {
  return items[Math.floor(r * items.length) % items.length] as T
}

/**
 * A large, realistic-looking document for performance tests: one page, a grid
 * of artboards, each filled with flex "section" frames containing text and
 * rectangles. Built in a single commit.
 */
export function generateBenchDoc(options: BenchDocOptions): LoroDoc {
  const artboards = Math.max(0, Math.trunc(options.artboards))
  const perArtboard = Math.max(0, Math.trunc(options.nodesPerArtboard))
  const width = options.artboardWidth ?? 1440
  const height = options.artboardHeight ?? 900
  const columns = Math.max(1, options.columns ?? Math.ceil(Math.sqrt(Math.max(1, artboards))))
  const rand = prng(options.seed ?? 1)
  const docOptions =
    options.peerId === undefined
      ? { pageName: 'Bench' }
      : { pageName: 'Bench', peerId: options.peerId }
  const doc = createEmptyDoc(options.name ?? 'Bench', docOptions)
  const tree = nodesTree(doc)
  const page = tree.roots()[0]
  if (!page) throw new Error('createEmptyDoc did not create a page')

  const mainCount = Math.max(0, Math.trunc(options.components?.mains ?? 0))
  const ctx: Phase3Ctx = {
    leaf: 0,
    mains: [],
    instanceNth: mainCount > 0 ? Math.max(1, Math.trunc(options.components?.everyNth ?? 0)) : 0,
    vectorNth: options.vectors ? Math.max(1, Math.trunc(options.vectors.everyNth)) : 0,
  }

  transact(
    doc,
    () => {
      if (mainCount > 0) {
        const componentsPage = tree.createNode()
        writeNodeData(componentsPage.data, {
          type: 'page',
          name: 'Components',
          background: '#EEEEEE',
        })
        for (let m = 0; m < mainCount; m++) {
          const main = buildMain(componentsPage, m, rand)
          writeRegistry(doc, main.key, main.id)
          ctx.mains.push(main)
        }
      }
      for (let a = 0; a < artboards; a++) {
        const artboard = page.createNode()
        writeNodeData(artboard.data, {
          type: 'frame',
          name: `Artboard ${a + 1}`,
          styles: {
            left: (a % columns) * (width + ARTBOARD_GAP),
            top: Math.floor(a / columns) * (height + ARTBOARD_GAP),
            width,
            height,
            display: 'flex',
            flexDirection: 'column',
            gap: '24px',
            padding: '48px',
            backgroundColor: '#FFFFFF',
            overflow: 'hidden',
          },
        })
        fillArtboard(artboard, perArtboard, rand, ctx)
      }
    },
    { origin: 'bench' },
  )
  return doc
}

function fillArtboard(
  artboard: LoroTreeNode,
  count: number,
  rand: () => number,
  ctx: Phase3Ctx,
): void {
  let section: LoroTreeNode | null = null
  let inSection = 0
  for (let i = 0; i < count; i++) {
    if (section === null || inSection >= SECTION_SIZE) {
      section = artboard.createNode()
      writeNodeData(section.data, {
        type: 'frame',
        name: `Section ${i}`,
        styles: {
          display: 'flex',
          flexDirection: rand() < 0.5 ? 'row' : 'column',
          gap: `${4 + Math.floor(rand() * 4) * 4}px`,
          padding: '16px',
          borderRadius: '8px',
          backgroundColor: pick(PALETTE, rand()),
        },
      })
      inSection = 0
      continue
    }
    const node = section.createNode()
    const leaf = ctx.leaf++
    if (ctx.instanceNth > 0 && leaf % ctx.instanceNth === 0) {
      const main = ctx.mains[(leaf / ctx.instanceNth) % ctx.mains.length] as BenchMain
      const n = leaf / ctx.instanceNth
      writeNodeData(node.data, {
        type: 'instance',
        name: '',
        componentKey: main.key,
        mainId: main.id,
        styles: { flexShrink: 0 },
        overrides: n % 2 === 1 ? { [main.titleKey]: { text: `Card ${i}` } } : {},
      })
      inSection++
      continue
    }
    if (ctx.vectorNth > 0 && (leaf + 1) % ctx.vectorNth === 0) {
      writeNodeData(node.data, {
        type: 'vector',
        name: `Vector ${i}`,
        styles: {
          width: 32,
          height: 32,
          fill: pick(PALETTE, rand()),
          stroke: '#141414',
          strokeWidth: 1,
        },
        vector: {
          fillRule: 'nonzero',
          subpaths: [{ id: newSubpathId(rand), closed: true, points: starPoints() }],
        },
      })
      inSection++
      continue
    }
    const type: NodeType = rand() < 0.6 ? 'text' : 'rect'
    const styles: Styles =
      type === 'text'
        ? {
            fontFamily: 'Inter',
            fontSize: `${12 + Math.floor(rand() * 4) * 2}px`,
            lineHeight: '20px',
            color: pick(PALETTE, rand()),
          }
        : {
            width: `${24 + Math.floor(rand() * 8) * 16}px`,
            height: `${16 + Math.floor(rand() * 4) * 8}px`,
            borderRadius: '4px',
            backgroundColor: pick(PALETTE, rand()),
          }
    if (type === 'text') {
      writeNodeData(node.data, {
        type,
        name: `Text ${i}`,
        styles,
        text: `${pick(WORDS, rand())} ${i}`,
      })
    } else {
      writeNodeData(node.data, { type, name: `Rectangle ${i}`, styles })
    }
    inSection++
  }
}
