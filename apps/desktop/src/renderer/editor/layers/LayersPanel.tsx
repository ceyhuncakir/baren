/**
 * Virtualized layer tree (artboards 05, 06, 14, 29–33). Rows come from the lazy LayerTree
 * cache, flattened over expanded nodes; only the ~30 visible rows render, and memoized
 * LayerRows re-render only when their own props change. Supports multi-select, rename,
 * lock/hide, keyboard navigation, reveal-on-select and drag to reorder/reparent.
 *
 * Phase 3: groups are containers and drop targets; instance rows expand into their resolved
 * content (virtual rows: select, hover and hide only); drops go through the schema's
 * `reparentNodes` (the same helper as the canvas drag), and refused drops (component cycles,
 * instance content) show no indicator. With components in the file the tree gets a
 * "Layers" header row (31).
 */
import { canReparent, isTreeId } from '@baren/schema'
import {
  LAYER_ROW_HEIGHT,
  LayerRow,
  LayerTypeIcon,
  PanelSectionHeader,
  type LayerKind,
} from '@baren/ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { moveLayers, renameNode, setFlag } from '../model/docOps'
import { useEditor, useEditorState, useLayerTreeVersion } from '../session/context'
import { canEdit } from '../session/readOnly'
import { hoverId, selectIds } from '../session/selection'
import { dropTargetAt, type DropTarget } from './dnd'
import { flattenLayers, indexOfRow, rowState, type FlatRow } from './flatten'
import css from '../Editor.module.css'

const ICONS: Record<LayerKind, ReactElement> = {
  artboard: <LayerTypeIcon kind="artboard" />,
  'frame-column': <LayerTypeIcon kind="frame-column" />,
  'frame-row': <LayerTypeIcon kind="frame-row" />,
  frame: <LayerTypeIcon kind="frame" />,
  text: <LayerTypeIcon kind="text" />,
  rect: <LayerTypeIcon kind="rect" />,
  svg: <LayerTypeIcon kind="svg" />,
  image: <LayerTypeIcon kind="image" />,
  component: <LayerTypeIcon kind="component" />,
  group: <LayerTypeIcon kind="group" />,
  vector: <LayerTypeIcon kind="vector" />,
  instance: <LayerTypeIcon kind="instance" />,
}

const DRAG_THRESHOLD = 4

/**
 * Clicking a row selects it but keeps DOM focus on the tree container: the
 * row's focus-within state would otherwise reveal its lock/eye buttons until the next click.
 */
function keepTreeFocus(e: { target: EventTarget; preventDefault(): void }) {
  const target = e.target as HTMLElement
  if (target.closest('input, button')) return
  e.preventDefault()
}
const PADDING = 6

interface DragState {
  rowId: string
  pointerId: number
  startX: number
  startY: number
  ids: string[]
  active: boolean
}

export function LayersPanel({ header = false }: { header?: boolean }) {
  const session = useEditor()
  const { tree, store, doc } = session
  const version = useLayerTreeVersion()
  const pageId = useEditorState((s) => s.pageId)
  const expanded = useEditorState((s) => s.expanded)
  const selection = useEditorState((s) => s.selection)
  const hovered = useEditorState((s) => s.hoveredId)
  const renamingId = useEditorState((s) => s.renamingId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  /** Set by keyboard navigation: the selected row then takes DOM focus. */
  const keyboardNav = useRef(false)
  const [drag, setDrag] = useState<{ ids: ReadonlySet<string>; target: DropTarget | null } | null>(
    null,
  )

  const rows = useMemo(
    () => flattenLayers(tree, pageId, expanded),
    // `version` invalidates the cached tree reads.
    [tree, pageId, expanded, version],
  )
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const selectedSet = useMemo(() => new Set(selection), [selection])
  const scopeParents = useMemo(() => {
    const out = new Set<string>()
    for (const id of selection) {
      const p = tree.parent(id)
      if (p !== null && tree.meta(p)?.type !== 'page') out.add(p)
    }
    return out
  }, [selection, tree, version])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LAYER_ROW_HEIGHT,
    overscan: 10,
    // With the "Layers" header the section's own 6 px padding sits above the header.
    paddingStart: header ? 0 : PADDING,
    paddingEnd: PADDING,
    getItemKey: (i) => rows[i]?.id ?? i,
  })

  // Reveal the selection: expand its ancestors, then (once the rows exist) scroll the
  // first selected row into view.
  const lastSelection = useRef('')
  const pendingReveal = useRef<string | null>(null)
  useEffect(() => {
    const key = selection.join('|')
    if (key === lastSelection.current) return
    lastSelection.current = key
    const first = selection[0]
    pendingReveal.current = first ?? null
    if (first === undefined) return
    const toOpen: string[] = []
    for (const id of selection) {
      for (const a of tree.ancestors(id)) {
        if (tree.meta(a)?.type === 'page') break
        if (!store.getState().expanded.has(a)) toOpen.push(a)
      }
    }
    if (toOpen.length === 0) return
    store.setState((s) => {
      const next = new Set(s.expanded)
      for (const a of toOpen) next.add(a)
      return { expanded: next }
    })
  }, [selection, tree, store])
  useEffect(() => {
    const id = pendingReveal.current
    if (id === null) return
    const index = indexOfRow(rows, id)
    if (index < 0) return // its ancestors are still expanding
    pendingReveal.current = null
    virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [rows, selection, virtualizer])

  const onToggleExpanded = useCallback(
    (id: string) => {
      store.setState((s) => {
        const next = new Set(s.expanded)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return { expanded: next }
      })
    },
    [store],
  )

  const onSelectRow = useCallback(
    (id: string, e: ReactPointerEvent<HTMLDivElement>) => {
      scrollRef.current?.focus({ preventScroll: true })
      const current = store.getState().selection
      if (e.shiftKey && anchorRef.current !== null) {
        const list = rowsRef.current
        const a = indexOfRow(list, anchorRef.current)
        const b = indexOfRow(list, id)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          selectIds(
            session,
            list.slice(lo, hi + 1).map((r) => r.id),
          )
          return
        }
      }
      if (e.ctrlKey || e.metaKey) {
        anchorRef.current = id
        selectIds(
          session,
          current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
        )
        return
      }
      anchorRef.current = id
      // Keep a multi-selection when pressing one of its rows (it may become a drag).
      if (!current.includes(id)) selectIds(session, [id])
    },
    [session, store],
  )

  // A viewer selects and expands layers but changes nothing (`session/readOnly`).
  const onStartRename = useCallback(
    (id: string) => {
      if (isTreeId(id) && canEdit(session)) store.setState({ renamingId: id })
    },
    [session, store],
  )
  const onRename = useCallback(
    (id: string, name: string) => {
      if (canEdit(session)) renameNode(doc, id, name)
      store.setState({ renamingId: null })
    },
    [session, doc, store],
  )
  const onRenameCancel = useCallback(() => store.setState({ renamingId: null }), [store])
  const onToggleLocked = useCallback(
    (id: string) => {
      if (isTreeId(id) && canEdit(session)) {
        setFlag(doc, [id], 'locked', !(tree.meta(id)?.locked ?? false))
      }
    },
    [session, doc, tree],
  )
  const onToggleHidden = useCallback(
    (id: string) => {
      if (canEdit(session)) setFlag(doc, [id], 'hidden', !(tree.meta(id)?.hidden ?? false))
    },
    [session, doc, tree],
  )

  // --- Drag and drop ------------------------------------------------------------

  const contentY = (clientY: number): number => {
    const el = scrollRef.current
    if (!el) return 0
    return clientY - el.getBoundingClientRect().top + el.scrollTop - (header ? 0 : PADDING)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-row-id]')
    if (!rowEl || (e.target as HTMLElement).closest('button, input')) return
    const id = rowEl.dataset['rowId']
    if (!id || renamingId !== null) return
    const sel = store.getState().selection
    // Expanded instance content cannot be moved; a plain click still selects it.
    const ids = (sel.includes(id) ? [...sel] : [id]).filter((x) => isTreeId(x))
    dragRef.current = {
      rowId: id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      ids,
      active: false,
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.active) {
      if (d.ids.length === 0) return
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return
      if (!canEdit(session)) {
        dragRef.current = null
        return
      }
      d.active = true
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    const el = scrollRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      if (e.clientY < r.top + 24) el.scrollTop -= 8
      else if (e.clientY > r.bottom - 24) el.scrollTop += 8
    }
    const ids = new Set(d.ids)
    const target = dropTargetAt(
      rowsRef.current,
      contentY(e.clientY),
      LAYER_ROW_HEIGHT,
      tree,
      pageId,
      ids,
      (parentId) => canReparent(doc, d.ids, parentId).ok,
    )
    setDrag((prev) =>
      prev &&
      prev.target?.rowId === target?.rowId &&
      prev.target?.position === target?.position &&
      prev.ids.size === ids.size
        ? prev
        : { ids, target },
    )
  }

  const endDrag = (commit: boolean) => {
    const d = dragRef.current
    dragRef.current = null
    const target = drag?.target ?? null
    setDrag(null)
    if (d && !d.active && commit && d.ids.length > 1) {
      // A plain click on a row of a multi-selection selects just that row.
      selectIds(session, [d.rowId])
      return
    }
    if (!d?.active || !commit || !target) return
    moveLayers(doc, d.ids, target.parentId, target.index, session.actions.geometry())
    if (target.position === 'inside') {
      store.setState((s) =>
        s.expanded.has(target.parentId)
          ? s
          : { expanded: new Set(s.expanded).add(target.parentId) },
      )
    }
  }

  // --- Keyboard -----------------------------------------------------------------

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || renamingId !== null) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const list = rowsRef.current
    const current = store.getState().selection
    const last = current[current.length - 1]
    const index = last === undefined ? -1 : indexOfRow(list, last)
    const go = (i: number) => {
      const row = list[Math.max(0, Math.min(list.length - 1, i))]
      if (!row) return
      e.preventDefault()
      keyboardNav.current = true
      anchorRef.current = row.id
      selectIds(session, [row.id])
      virtualizer.scrollToIndex(indexOfRow(list, row.id), { align: 'auto' })
    }
    switch (e.key) {
      case 'ArrowDown':
        go(index + 1)
        break
      case 'ArrowUp':
        go(index <= 0 ? 0 : index - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(list.length - 1)
        break
      case 'ArrowLeft': {
        const row = list[index]
        if (row && row.parentIndex !== -1) go(row.parentIndex)
        break
      }
      case 'ArrowRight': {
        const row = list[index]
        if (row?.expanded) go(index + 1)
        break
      }
      case 'Escape':
        if (current.length > 0) {
          e.preventDefault()
          selectIds(session, [])
        }
        break
    }
  }

  // Keep DOM focus on the selected row after keyboard moves.
  useEffect(() => {
    const el = scrollRef.current
    if (!keyboardNav.current) return
    keyboardNav.current = false
    if (!el || !el.contains(document.activeElement)) return
    const last = selection[selection.length - 1]
    if (last === undefined) return
    const row = el.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(last)}"]`)
    if (row && document.activeElement !== row) row.focus({ preventScroll: true })
  }, [selection, rows])

  // Hover follows the pointer across rows and clears over empty list space.
  const onPointerOver = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current?.active) return
      const slot = (e.target as HTMLElement).closest<HTMLElement>('[data-slot-id]')
      const id = slot?.dataset['slotId'] ?? null
      if (session.store.getState().hoveredId !== id) hoverId(session, id)
    },
    [session],
  )
  const onListLeave = useCallback(() => hoverId(session, null), [session])

  const items = virtualizer.getVirtualItems()
  const open = useEditorState((s) => s.layersExpanded) || !header
  const list = (
    <div
      ref={scrollRef}
      className={css.layers}
      hidden={!open}
      role="tree"
      aria-label="Layers"
      aria-multiselectable="true"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onPointerOver={onPointerOver}
      onPointerLeave={onListLeave}
      onContextMenu={(e) => {
        const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-row-id]')
        if (!rowEl) return
        e.preventDefault()
        const id = rowEl.dataset['rowId']
        if (id && !store.getState().selection.includes(id)) selectIds(session, [id])
        store.setState({
          contextMenu: { x: e.clientX, y: e.clientY, source: 'layers', world: null },
        })
      }}
    >
      <div className={css.layersInner} style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index] as FlatRow
          const meta = tree.meta(row.id)
          if (!meta) return null
          const target = drag?.target
          return (
            <div
              key={item.key}
              className={css.layerRowSlot}
              data-slot-id={row.id}
              style={{ transform: `translateY(${item.start}px)` }}
              onMouseDown={keepTreeFocus}
            >
              <LayerRow
                id={row.id}
                data-row-id={row.id}
                name={meta.name}
                depth={row.depth}
                icon={ICONS[meta.kind]}
                expandable={row.expandable}
                expanded={row.expanded}
                state={rowState(rows, item.index, selectedSet, scopeParents)}
                locked={meta.locked}
                hidden={meta.hidden}
                lockable={!meta.virtual}
                renaming={renamingId === row.id}
                dragging={drag?.ids.has(row.id) ?? false}
                dropPosition={target && target.rowId === row.id ? target.position : null}
                data-hover={hovered === row.id && !drag ? '' : undefined}
                onToggleExpanded={onToggleExpanded}
                onSelectRow={onSelectRow}
                onStartRename={onStartRename}
                onRename={onRename}
                onRenameCancel={onRenameCancel}
                onToggleLocked={onToggleLocked}
                onToggleHidden={onToggleHidden}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
  if (!header) return list
  return (
    <div className={css.layersSection}>
      <PanelSectionHeader
        title="Layers"
        expanded={open}
        onClick={() => store.setState((st) => ({ layersExpanded: !st.layersExpanded }))}
      />
      {list}
    </div>
  )
}
