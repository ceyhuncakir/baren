/**
 * Selection colors (artboard 06): every color used inside the selected layers' subtrees,
 * with usage counts. The target selects the layers using a color; editing a swatch
 * rewrites every occurrence in one commit. Computed off the critical path (idle callback)
 * and capped, so selecting a huge artboard never blocks input.
 */
import {
  ColorPicker,
  InspectorSection,
  Popover,
  SelectionColorRow,
  hexToHsva,
  hsvaToHex,
  type Hsva,
} from '@baren/ui'
import { setStylesAt, toRenderSubtree, transact, type DesignNode, type Styles } from '@baren/schema'
import { useEffect, useRef, useState } from 'react'
import { formatColor, resolveColor, tokenShortName } from '../../model/colors'
import { ORIGIN } from '../../model/docOps'
import { previewStyles, cancelPreview } from '../../model/previewEdits'
import {
  aggregateColors,
  replaceColorPatch,
  type SelectionColor,
} from '../../model/selectionColors'
import { useEditor, useTokens } from '../../session/context'
import type { NodesSnapshot } from '../../session/docEvents'
import { selectIds } from '../../session/selection'
import css from '../Inspector.module.css'

/** Upper bound on nodes scanned (the count shows "99+" anyway). */
const MAX_NODES = 20_000
const MAX_ROWS = 8

function idle(cb: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const h = requestIdleCallback(cb, { timeout: 200 })
    return () => cancelIdleCallback(h)
  }
  const t = setTimeout(cb, 16)
  return () => clearTimeout(t)
}

export function SelectionColorsSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const session = useEditor()
  const { doc, events, resolver } = session
  const tokens = useTokens()
  const [colors, setColors] = useState<SelectionColor[]>([])
  const [editing, setEditing] = useState<{
    key: string
    hsva: Hsva
    ids: string[]
    /** Styles before the edit: every preview patches from these, not from the last preview. */
    originals: Map<string, Styles>
  } | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const anchorRef = useRef<HTMLElement | null>(null)
  const rootIds = snapshot.nodes.map((n) => n.id)
  const rootKey = rootIds.join('|')

  // Recompute on selection change and (debounced) when the doc changes. Subtrees are read
  // one root at a time with a yield in between, so selecting 40 artboards never blocks.
  useEffect(() => {
    let cancelled = false
    let generation = 0
    let cancelIdle: (() => void) | null = null
    const compute = async (gen: number) => {
      const nodes: DesignNode[] = []
      for (const id of rootKey.split('|')) {
        if (!id) continue
        if (cancelled || gen !== generation) return
        // Instances count with their resolved content (edits become overrides).
        const sub = toRenderSubtree(doc, id, resolver)
        if (sub) for (const n of Object.values(sub.nodes)) nodes.push(n)
        if (nodes.length > MAX_NODES) break
        await new Promise<void>((r) => setTimeout(r, 0))
      }
      if (!cancelled && gen === generation) setColors(aggregateColors(nodes))
    }
    const schedule = () => {
      cancelIdle?.()
      const gen = ++generation
      cancelIdle = idle(() => void compute(gen))
    }
    schedule()
    const off = events.subscribe((batch) => {
      if (batch.changes.some((c) => c.kind !== 'text')) schedule()
    })
    return () => {
      cancelled = true
      off()
      cancelIdle?.()
    }
  }, [doc, events, resolver, rootKey])

  if (colors.length === 0) return null

  const apply = (
    edit: { key: string; ids: string[]; originals: Map<string, Styles> },
    cssValue: string,
    final: boolean,
  ) => {
    const patchFor = (_styles: Styles, id: string) => {
      const original = edit.originals.get(id)
      return original ? replaceColorPatch(original, edit.key, cssValue) : null
    }
    if (!final) {
      previewStyles(doc, edit.ids, patchFor)
      return
    }
    cancelPreview(doc)
    transact(
      doc,
      () => {
        for (const id of edit.ids) {
          const patch = patchFor({}, id)
          if (patch && Object.keys(patch).length > 0) setStylesAt(doc, id, patch, { resolver })
        }
      },
      { origin: ORIGIN.inspector },
    )
  }

  return (
    <InspectorSection title="Selection colors" tight bordered={false}>
      {colors.slice(0, MAX_ROWS).map((c) => {
        const lit = resolveColor(c.color, tokens)
        const name = c.color.kind === 'token' ? tokenShortName(c.color.token) : (lit?.hex ?? '')
        return (
          <div
            key={c.key}
            ref={(el) => {
              if (el) rowRefs.current.set(c.key, el)
              else rowRefs.current.delete(c.key)
            }}
          >
            <SelectionColorRow
              color={lit?.hex ?? '000000'}
              name={name}
              opacity={lit?.alpha ?? 1}
              count={c.count}
              onSelectUsages={() => selectIds(session, c.nodeIds)}
              onSwatchClick={() => {
                anchorRef.current = rowRefs.current.get(c.key) ?? null
                const originals = new Map<string, Styles>()
                for (const id of c.nodeIds) {
                  const node = resolver.resolveNode(id)
                  if (node) originals.set(id, node.styles)
                }
                setEditing({
                  key: c.key,
                  ids: c.nodeIds,
                  originals,
                  hsva: hexToHsva(lit?.hex ?? '000000', lit?.alpha ?? 1) ?? {
                    h: 0,
                    s: 0,
                    v: 0,
                    a: 1,
                  },
                })
              }}
            />
          </div>
        )
      })}
      <Popover
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        anchorRef={anchorRef}
        placement="left-start"
        offset={12}
        width={240}
        aria-label="Edit color"
      >
        {editing && (
          <div className={css.colorPopover}>
            <ColorPicker
              value={editing.hsva}
              onChange={(hsva) => {
                setEditing({ ...editing, hsva })
                apply(editing, formatColor(hsvaToHex(hsva), hsva.a), false)
              }}
              onChangeEnd={(hsva) => {
                const next = formatColor(hsvaToHex(hsva), hsva.a)
                apply(editing, next, true)
                // The color's key changes with its value: close so the list re-groups.
                setEditing(null)
              }}
            />
          </div>
        )}
      </Popover>
    </InspectorSection>
  )
}
