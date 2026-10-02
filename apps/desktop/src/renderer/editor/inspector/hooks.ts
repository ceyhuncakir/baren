/**
 * Inspector plumbing: applying style edits to the selection (live previews while
 * scrubbing, one undoable commit at the end), measured bounds from the canvas, and the
 * per-node layout context (top level? parent flex direction?).
 */
import { fitGroups, type DesignNode, type StylePatch, type Styles, type Token } from '@baren/schema'
import { useCallback, useEffect, useState } from 'react'
import type { NodesSnapshot } from '../session/docEvents'
import { realIdOf } from '../model/docOps'
import { commitStyles, previewStyles } from '../model/previewEdits'
import { flexDirection, isFlex, type SizeContext } from '../model/styles'
import { useEditor, useEditorState } from '../session/context'

export type PatchFor = (styles: Styles, id: string) => StylePatch | null

/**
 * `edit(patchFor, final)`: preview when `final` is false, otherwise one undoable commit. The
 * commit refits the groups around the edited layers (a size or position change inside a group
 * moves its box, contract §2.5.1).
 */
export function useStyleEdit(): (patchFor: PatchFor, final?: boolean) => void {
  const { doc, actions } = useEditor()
  const ids = useEditorState((s) => s.selection)
  return useCallback(
    (patchFor: PatchFor, final = true) => {
      if (final) {
        commitStyles(doc, ids, patchFor, undefined, (targets) =>
          fitGroups(doc, [...new Set(targets.map(realIdOf))], actions.geometry()),
        )
      } else previewStyles(doc, ids, patchFor)
    },
    [doc, ids, actions],
  )
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

function sameBounds(a: readonly (Bounds | null)[], b: readonly (Bounds | null)[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]
    const q = b[i]
    if (p === q) continue
    if (!p || !q) return false
    if (p.x !== q.x || p.y !== q.y || p.width !== q.width || p.height !== q.height) return false
  }
  return true
}

/**
 * Measured world bounds of the nodes and their parents. The canvas measures in its own
 * frame after a change, so bounds are re-read two frames after every snapshot change.
 */
export function useBounds(snapshot: NodesSnapshot): {
  nodes: readonly (Bounds | null)[]
  parents: readonly (Bounds | null)[]
} {
  const { canvas } = useEditor()
  const read = useCallback(
    () => ({
      nodes: snapshot.nodes.map((n) => canvas.current?.getNodeBounds(n.id) ?? null),
      parents: snapshot.parents.map((p) =>
        p && p.type !== 'page' ? (canvas.current?.getNodeBounds(p.id) ?? null) : null,
      ),
    }),
    [canvas, snapshot],
  )
  const [bounds, setBounds] = useState(read)
  useEffect(() => {
    let raf2 = 0
    const update = () =>
      setBounds((prev) => {
        const next = read()
        return sameBounds(prev.nodes, next.nodes) && sameBounds(prev.parents, next.parents)
          ? prev
          : next
      })
    update()
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(update)
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [read])
  return bounds
}

export function sizeContext(node: DesignNode, parent: DesignNode | null): SizeContext {
  const parentIsPage = parent === null || parent.type === 'page'
  return {
    type: node.type,
    isTop: parentIsPage,
    parentFlexDirection:
      !parentIsPage && parent && isFlex(parent.styles) ? flexDirection(parent.styles) : null,
  }
}

const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)/g

/** Substitute token values into a style value (for display: `var(--text-xl)` → `22px`). */
export function resolveVars(value: string, tokens: Record<string, Token>, depth = 0): string {
  if (depth > 4 || !value.includes('var(')) return value
  const out = value.replace(VAR_RE, (_m, name: string, fallback: string | undefined) => {
    const t = tokens[name]
    if (t) return String(t.value)
    return fallback?.trim() ?? ''
  })
  return out.includes('var(') ? resolveVars(out, tokens, depth + 1) : out
}

/** Styles with token references resolved (only string values containing var()). */
export function resolveStyles(styles: Styles, tokens: Record<string, Token>): Styles {
  let out: Styles | null = null
  for (const [k, v] of Object.entries(styles)) {
    if (typeof v === 'string' && v.includes('var(')) {
      out ??= { ...styles }
      out[k] = resolveVars(v, tokens)
    }
  }
  return out ?? styles
}
