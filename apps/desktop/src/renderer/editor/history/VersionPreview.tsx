/**
 * Previewing a version: the file as it was, read-only, on its own canvas over the live one (a
 * fork of the document at the version's frontiers, so nothing reaches the live file), with a
 * banner to restore it or go back. While it shows, the live canvas is read-only and its
 * selection cleared; leaving the preview gives it back untouched. Escape goes back.
 */
import { docAtVersion, getChildIds, getNode, type DocVersion } from '@baren/schema'
import type { CanvasController } from '@baren/canvas'
import { DesignCanvas } from '@baren/canvas/react'
import { Button, ChevronDownIcon, DropdownMenu, HistoryIcon, MenuItem } from '@baren/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveCanvasAsset } from '../../lib/assets'
import { useNow } from '../../lib/relativeTime'
import { useEditor, useEditorState, useVersions } from '../session/context'
import { useViewer } from '../session/readOnly'
import { previewVersion } from './commands'
import { versionLabel, versionTime } from './model'
import { RestoreConfirm } from './RestoreConfirm'
import css from './History.module.css'

const CANVAS_STYLE = { position: 'absolute', inset: 0 } as const

function PagePicker({
  pages,
  value,
  onChange,
}: {
  pages: { id: string; name: string }[]
  value: string
  onChange: (id: string) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = pages.find((p) => p.id === value)
  return (
    <>
      <Button
        ref={ref}
        variant="ghost"
        size={26}
        trailingIcon={<ChevronDownIcon size={12} />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.name ?? 'Page'}
      </Button>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={ref}
        width={200}
        aria-label="Pages in this version"
      >
        {pages.map((p) => (
          <MenuItem key={p.id} checked={p.id === value} onSelect={() => onChange(p.id)}>
            {p.name}
          </MenuItem>
        ))}
      </DropdownMenu>
    </>
  )
}

function Preview({ version }: { version: DocVersion }) {
  const session = useEditor()
  const { doc, canvas } = session
  const livePage = useEditorState((s) => s.pageId)
  const viewer = useViewer()
  const now = useNow()
  const [restoring, setRestoring] = useState<DocVersion | null>(null)

  // A fork per previewed version. Not freed by hand: StrictMode re-runs effects with the same
  // memo, and Loro docs are freed by the garbage collector (FinalizationRegistry).
  const past = useMemo(() => docAtVersion(doc, version), [doc, version.id])
  const pages = useMemo(
    () => getChildIds(past, null).map((id) => ({ id, name: getNode(past, id)?.name ?? 'Page' })),
    [past],
  )
  const [pageId, setPageId] = useState(() =>
    pages.some((p) => p.id === livePage) ? livePage : (pages[0]?.id ?? livePage),
  )
  // The live camera at the moment the preview opened: the same view, as it was.
  const [viewport] = useState(() => {
    const v = canvas.current?.getViewport()
    return v ? { x: v.x, y: v.y, zoom: v.zoom } : ('fit' as const)
  })

  // The live canvas is unselected while the preview covers it (CanvasArea makes it read-only).
  useEffect(() => {
    const live: CanvasController | null = canvas.current
    if (!live) return
    live.select([])
    live.stopEditing()
  }, [canvas])

  // Escape goes back to the live file (dialogs and menus handle their own Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target as Element | null
      if (target?.closest?.('[role="dialog"], [role="menu"], input, textarea')) return
      e.preventDefault()
      previewVersion(session, null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])

  return (
    <div className={css.preview} data-testid="version-preview">
      <DesignCanvas
        doc={past}
        pageId={pageId}
        viewport={pages.some((p) => p.id === livePage) && pageId === livePage ? viewport : 'fit'}
        readOnly
        keyboard="none"
        undo={false}
        resolveAsset={resolveCanvasAsset}
        style={CANVAS_STYLE}
      />
      <div className={css.banner} role="status" aria-label="Previewing a version">
        <HistoryIcon size={15} className={css.bannerIcon} />
        <span className={css.bannerText}>
          <span className={css.bannerTitle}>{versionLabel(version)}</span>
          <span className={css.bannerTime}>{versionTime(version.createdAt, now)}</span>
        </span>
        <span className={css.readOnlyBadge}>Read-only</span>
        {pages.length > 1 && <PagePicker pages={pages} value={pageId} onChange={setPageId} />}
        <span className={css.bannerActions}>
          <Button variant="outline" size={26} onClick={() => previewVersion(session, null)}>
            Back to current
          </Button>
          <Button
            variant="primary"
            size={26}
            disabled={viewer}
            title={viewer ? "Viewers can't restore versions" : undefined}
            onClick={() => setRestoring(version)}
          >
            Restore this version
          </Button>
        </span>
      </div>
      <RestoreConfirm version={restoring} onClose={() => setRestoring(null)} />
    </div>
  )
}

/** The open preview, or nothing; a version deleted while previewed ends the preview. */
export function VersionPreview() {
  const session = useEditor()
  const id = useEditorState((s) => s.previewVersionId)
  const versions = useVersions()
  const version = id === null ? null : (versions.find((v) => v.id === id) ?? null)
  useEffect(() => {
    if (id !== null && version === null) previewVersion(session, null)
  }, [id, version, session])
  return version ? <Preview key={version.id} version={version} /> : null
}
