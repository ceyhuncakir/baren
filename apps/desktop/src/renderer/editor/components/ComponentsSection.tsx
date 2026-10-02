/**
 * "Components" section of the left panel (artboards 31, 32): the file's main components with
 * their instance counts, between Pages and Layers. Click goes to the main; dragging a row onto
 * the canvas inserts an instance at the drop point. The row of the selection's component gets
 * the faint component tint. Hidden when the file has no components (Phase 2 layout).
 */
import { MainComponentIcon, PanelSectionHeader, SearchIcon, SectionAction } from '@baren/ui'
import { useMemo, useRef, useState } from 'react'
import { useComponents, useEditor, useEditorState, useSelectedNodes } from '../session/context'
import { endComponentDrag, startComponentDrag } from './componentDrag'
import css from './Components.module.css'

/** Component keys the selection shows (instances) and the keys of selected mains. */
export function useSelectionComponents(): {
  shown: ReadonlySet<string>
  mains: ReadonlySet<string>
} {
  const nodes = useSelectedNodes().nodes
  return useMemo(() => {
    const shown = new Set<string>()
    const mains = new Set<string>()
    for (const n of nodes) {
      if (n.type === 'instance' && n.componentKey) shown.add(n.componentKey)
      else if (n.type === 'frame' && n.componentKey && !n.id.includes('/'))
        mains.add(n.componentKey)
    }
    return { shown, mains }
  }, [nodes])
}

export function ComponentsSection() {
  const session = useEditor()
  const { store, actions } = session
  const { list, counts } = useComponents()
  const open = useEditorState((s) => s.componentsExpanded)
  const { shown, mains } = useSelectionComponents()
  const [query, setQuery] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  if (list.length === 0) return null
  const q = query?.trim().toLowerCase() ?? ''
  const rows = q === '' ? list : list.filter((c) => c.name.toLowerCase().includes(q))
  return (
    <div className={css.section} aria-label="Components">
      <PanelSectionHeader
        title="Components"
        expanded={open}
        onClick={() => store.setState({ componentsExpanded: !open })}
        action={
          <SectionAction
            label="Search components"
            aria-pressed={query !== null}
            onClick={() => {
              if (query === null) {
                setQuery('')
                store.setState({ componentsExpanded: true })
                requestAnimationFrame(() => searchRef.current?.focus())
              } else setQuery(null)
            }}
          >
            <SearchIcon size={13} />
          </SectionAction>
        }
      />
      {open && query !== null && (
        <div className={css.searchRow}>
          <input
            ref={searchRef}
            className={css.searchInput}
            value={query}
            placeholder="Search components"
            aria-label="Search components"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') setQuery(null)
            }}
          />
        </div>
      )}
      {open && (
        <div className={css.list} role="list">
          {rows.map((c) => (
            <button
              key={c.key}
              type="button"
              role="listitem"
              className={css.row}
              data-state={mains.has(c.key) ? 'main' : shown.has(c.key) ? 'related' : undefined}
              title={`${c.name} — click to go to the main component, drag to insert`}
              draggable
              onDragStart={(e) => startComponentDrag(e.dataTransfer, c.key)}
              onDragEnd={endComponentDrag}
              onClick={() => actions.reveal(c.mainId)}
            >
              <MainComponentIcon
                size={13}
                strokeWidth={2}
                fill="currentColor"
                className={css.icon}
              />
              <span className={css.name}>{c.name}</span>
              <span className={css.count}>{counts[c.key] ?? 0}</span>
            </button>
          ))}
          {rows.length === 0 && <div className={css.empty}>No components match</div>}
        </div>
      )}
    </div>
  )
}
