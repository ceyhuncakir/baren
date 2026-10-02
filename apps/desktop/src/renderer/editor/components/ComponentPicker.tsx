/**
 * Component picker (artboard 32): the tool rail's component tool (K) opens it next to its
 * button. Search, "In this file" with a 2-column grid of live previews; click inserts an
 * instance at the viewport centre (inside the selected frame, or beside the selection), a drag
 * onto the canvas inserts it at the drop point.
 */
import { MainComponentSolidIcon, Popover, SearchIcon } from '@baren/ui'
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useComponents, useEditor, useEditorState } from '../session/context'
import { endComponentDrag, startComponentDrag } from './componentDrag'
import { ComponentPreview } from './ComponentPreview'
import css from './Components.module.css'

/** Re-render previews when any component's content changes (live propagation). */
function useComponentsVersion(open: boolean): number {
  const { events } = useEditor()
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!open) return
    return events.subscribe((_batch, affected) => {
      if (affected.components.size > 0) setVersion((v) => v + 1)
    })
  }, [events, open])
  return version
}

export function ComponentPicker({ anchorRef }: { anchorRef: RefObject<HTMLElement | null> }) {
  const session = useEditor()
  const { store, actions } = session
  const open = useEditorState((s) => s.componentPickerOpen)
  const { list } = useComponents()
  const [query, setQuery] = useState('')
  const version = useComponentsVersion(open)
  const close = () => store.setState({ componentPickerOpen: false })
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const items = q === '' ? list : list.filter((c) => c.name.toLowerCase().includes(q))
    const out: (typeof items)[] = []
    for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2))
    return out
  }, [list, query])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => store.setState({ componentPickerOpen: next })}
      anchorRef={anchorRef}
      placement="right-start"
      offset={14}
      alignOffset={-7}
      width={288}
      className={css.picker}
      aria-label="Components"
    >
      <div className={css.pickerSearch}>
        <label className={css.pickerField}>
          <SearchIcon size={13} className={css.pickerSearchIcon} />
          <input
            className={css.pickerInput}
            value={query}
            placeholder="Search components"
            aria-label="Search components"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </label>
      </div>
      <div className={css.pickerLabel}>
        <span className={css.pickerLabelText}>In this file</span>
        <span className={css.pickerCount}>{list.length}</span>
      </div>
      <div className={css.pickerGrid}>
        {rows.map((pair) => (
          <div key={pair.map((c) => c.key).join('|')} className={css.pickerRow}>
            {pair.map((c) => (
              <button
                key={c.key}
                type="button"
                className={css.tile}
                aria-label={`Insert ${c.name}`}
                draggable
                onDragStart={(e) => startComponentDrag(e.dataTransfer, c.key)}
                onDragEnd={() => {
                  endComponentDrag()
                  close()
                }}
                onClick={() => {
                  close()
                  actions.insertInstance(c.key)
                }}
              >
                <ComponentPreview mainId={c.mainId} version={version} />
                <span className={css.tileCaption}>
                  <MainComponentSolidIcon size={10} className={css.icon} />
                  <span className={css.tileName}>{c.name}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
        {list.length === 0 && (
          <div className={css.pickerEmpty}>
            No components yet. Select layers and press Ctrl+Alt+K to create one.
          </div>
        )}
        {list.length > 0 && rows.length === 0 && (
          <div className={css.pickerEmpty}>No components match “{query}”</div>
        )}
      </div>
      <div className={css.pickerFooter}>Click to insert, or drag onto the canvas</div>
    </Popover>
  )
}
