/**
 * Tiny declarative builder for fixture documents: write a node tree as data, create it
 * with @baren/schema helpers inside the caller's transaction.
 */
import { createNode, type NodeType, type Styles, type VectorData } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

export interface NodeSpec {
  type: Exclude<NodeType, 'page'>
  name: string
  styles?: Styles
  text?: string
  svg?: string
  /** Image layer source / image fill asset and its file name. */
  assetId?: string
  assetName?: string
  /** Vector geometry (type `vector`). */
  vector?: VectorData
  children?: NodeSpec[]
}

export function frame(name: string, styles: Styles, children: NodeSpec[] = []): NodeSpec {
  return { type: 'frame', name, styles, children }
}

export function rect(name: string, styles: Styles): NodeSpec {
  return { type: 'rect', name, styles }
}

export function text(name: string, content: string, styles: Styles): NodeSpec {
  return { type: 'text', name, text: content, styles }
}

export function svg(name: string, markup: string, styles: Styles = {}): NodeSpec {
  return { type: 'svg', name, svg: markup, styles }
}

export function group(name: string, styles: Styles, children: NodeSpec[]): NodeSpec {
  return { type: 'group', name, styles, children }
}

export function vector(name: string, data: VectorData, styles: Styles): NodeSpec {
  return { type: 'vector', name, vector: data, styles }
}

/** Create `spec` (and its subtree) under `parentId`; returns the new id. */
export function createSpec(doc: LoroDoc, spec: NodeSpec, parentId: string): string {
  const id = createNode(doc, {
    type: spec.type,
    parentId,
    name: spec.name,
    ...(spec.styles ? { styles: spec.styles } : {}),
    ...(spec.type === 'text' ? { text: spec.text ?? '' } : {}),
    ...(spec.svg !== undefined ? { svg: spec.svg } : {}),
    ...(spec.assetId !== undefined ? { assetId: spec.assetId } : {}),
    ...(spec.assetName !== undefined ? { assetName: spec.assetName } : {}),
    ...(spec.vector !== undefined ? { vector: spec.vector } : {}),
  })
  for (const child of spec.children ?? []) createSpec(doc, child, id)
  return id
}

/** Number of nodes in a spec tree (tests, perf fixtures). */
export function countSpec(spec: NodeSpec): number {
  return 1 + (spec.children ?? []).reduce((n, c) => n + countSpec(c), 0)
}

/** Theme-panel order = declaration order of a token record. */
export function orderOf(tokens: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.keys(tokens).map((name, i) => [name, i + 1]))
}
