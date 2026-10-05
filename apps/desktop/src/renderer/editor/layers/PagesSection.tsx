/**
 * "Pages" block of the left panel (artboards 04/05): collapsible list, add page, select,
 * rename on double-click, and a context menu with rename/delete.
 */
import {
  ContextMenu,
  FileIcon,
  MenuItem,
  MenuSeparator,
  PageRow,
  PanelSectionHeader,
  PlusIcon,
  SectionAction,
} from '@baren/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPage, deletePage, nextPageName, renameNode, ORIGIN } from '../model/docOps'
import { useEditor, useEditorState, useLayerTreeVersion } from '../session/context'
import { canEdit } from '../session/readOnly'
import css from '../Editor.module.css'

export function PagesSection() {
  const session = useEditor()
  const { tree, store, doc } = session
  useLayerTreeVersion()
  const pages = tree.pages()
  const pageId = useEditorState((s) => s.pageId)
  const open = useEditorState((s) => s.pagesExpanded)
  const renamingId = useEditorState((s) => s.renamingId)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  const selectPage = useCallback(
    (id: string) => {
      if (store.getState().pageId !== id)
        store.setState({ pageId: id, selection: [], hoveredId: null })
    },
    [store],
  )

  // A viewer switches pages but adds, renames and deletes none (`session/readOnly`).
  const addPage = () => {
    if (!canEdit(session)) return
    const id = createPage(doc, nextPageName(doc))
    store.setState({ pageId: id, selection: [], renamingId: id, pagesExpanded: true })
  }
  const startRename = (id: string) => {
    if (canEdit(session)) store.setState({ renamingId: id })
  }

  return (
    <div className={css.pages}>
      <PanelSectionHeader
        title="Pages"
        expanded={open}
        onClick={() => store.setState({ pagesExpanded: !open })}
        action={
          <SectionAction label="Add page" onClick={addPage}>
            <PlusIcon size={14} />
          </SectionAction>
        }
      />
      {open &&
        pages.map((id) => {
          const meta = tree.meta(id)
          if (!meta) return null
          if (renamingId === id) {
            return (
              <PageRenameRow
                key={id}
                name={meta.name}
                onDone={(name) => {
                  if (name !== null && canEdit(session)) renameNode(doc, id, name, ORIGIN.pages)
                  store.setState({ renamingId: null })
                }}
              />
            )
          }
          return (
            <PageRow
              key={id}
              active={id === pageId}
              onClick={() => selectPage(id)}
              onDoubleClick={() => startRename(id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, id })
              }}
              onKeyDown={(e) => {
                if (e.key === 'F2') {
                  e.preventDefault()
                  startRename(id)
                }
              }}
            >
              {meta.name}
            </PageRow>
          )
        })}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        width={200}
        onClose={() => setMenu(null)}
        aria-label="Page"
      >
        <MenuItem shortcut="F2" onSelect={() => menu && startRename(menu.id)}>
          Rename
        </MenuItem>
        <MenuItem onSelect={addPage}>Add page</MenuItem>
        <MenuSeparator />
        <MenuItem
          destructive
          disabled={pages.length <= 1}
          onSelect={() => {
            if (!menu || !canEdit(session)) return
            const wasCurrent = store.getState().pageId === menu.id
            if (deletePage(doc, menu.id) && wasCurrent) {
              const next = tree.pages().find((p) => p !== menu.id)
              if (next) store.setState({ pageId: next, selection: [] })
            }
          }}
        >
          Delete page
        </MenuItem>
      </ContextMenu>
    </div>
  )
}

function PageRenameRow({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    ref.current?.select()
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    const value = ref.current?.value.trim() ?? ''
    onDone(commit && value !== '' && value !== name ? value : null)
  }
  return (
    <div className={css.pageRenameRow}>
      <FileIcon size={13} strokeWidth={1.75} />
      <input
        ref={ref}
        className={css.pageRename}
        defaultValue={name}
        aria-label="Page name"
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') finish(true)
          else if (e.key === 'Escape') finish(false)
        }}
        onBlur={() => finish(true)}
      />
    </div>
  )
}
