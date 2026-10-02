/**
 * A live, scaled-down rendering of a main component (picker tiles, 32): the resolved subtree
 * through the schema's HTML renderer (the same exporter as Copy as HTML), shown as design
 * content (light tokens, the document's own tokens) and fitted into the tile.
 */
import { renderSubtreeHtml, toRenderSubtree } from '@baren/schema'
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { assetUrl } from '../../lib/assets'
import { useEditor, useTokens } from '../session/context'
import css from './Components.module.css'

/** Largest scale and the box the preview is fitted into (tile 124 × 72 minus a margin). */
const MAX_SCALE = 0.75
const FIT = { width: 84, height: 52 }

export const ComponentPreview = memo(function ComponentPreview({
  mainId,
  version,
}: {
  mainId: string
  /** Bumped when the component's content changes (live previews). */
  version: number
}) {
  const { doc, resolver } = useEditor()
  const tokens = useTokens()
  const html = useMemo(() => {
    const sub = toRenderSubtree(doc, mainId, resolver)
    if (!sub) return ''
    return renderSubtreeHtml(sub.nodes, mainId, { assetUrl: (hash) => assetUrl(hash) })
    // `version` invalidates the cached markup when the main changes.
  }, [doc, mainId, resolver, version])
  const vars = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [name, t] of Object.entries(tokens)) out[name] = String(t.value)
    return out
  }, [tokens])
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  useLayoutEffect(() => {
    const root = ref.current?.firstElementChild as HTMLElement | null
    if (!root) return
    const w = root.offsetWidth || 1
    const h = root.offsetHeight || 1
    setScale(Math.min(MAX_SCALE, FIT.width / w, FIT.height / h))
  }, [html])
  return (
    <div className={css.previewWell} data-design-content="">
      <div
        ref={ref}
        className={css.previewContent}
        style={{ ...vars, transform: `scale(${scale})` } as CSSProperties}
        // The schema renderer escapes text and sanitises SVG markup (no scripts or handlers).
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
})
