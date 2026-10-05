/**
 * The inspector while version history is open: "Save version", the current file, then named
 * versions and the automatic checkpoints grouped by day. A row previews its version read-only
 * on the canvas (`VersionPreview`); its menu names, restores or deletes it. Viewers can browse
 * and preview, not save, rename, delete or restore.
 */
import type { DocVersion } from '@baren/schema'
import {
  Avatar,
  Button,
  DropdownMenu,
  IconButton,
  InspectorSection,
  MenuItem,
  MenuSeparator,
  MoreHorizontalIcon,
  cx,
} from '@baren/ui'
import { useRef, useState } from 'react'
import { useNow } from '../../lib/relativeTime'
import { useCommentAuthor } from '../comments/hooks'
import { useEditor, useEditorState, useVersions } from '../session/context'
import { useViewer } from '../session/readOnly'
import { previewVersion } from './commands'
import { groupVersions, versionLabel, versionTime } from './model'
import { nameVersion, removeVersion, saveVersion } from './ops'
import { RestoreConfirm } from './RestoreConfirm'
import css from './History.module.css'

/** Name a new version, or rename one: an inline field; Enter saves, Escape cancels. */
function NameField({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: string
  submitLabel: string
  onSubmit: (name: string) => boolean
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const ok = name.trim() !== ''
  const submit = () => {
    if (ok && onSubmit(name)) onCancel()
  }
  return (
    <div className={css.nameField} data-history-ui="">
      <input
        className={css.nameInput}
        value={name}
        placeholder="Version name"
        aria-label="Version name"
        maxLength={200}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className={css.nameActions}>
        <Button variant="ghost" size={26} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size={26} disabled={!ok} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

function VersionRow({
  version,
  now,
  active,
  canWrite,
  onRestore,
}: {
  version: DocVersion
  now: number
  active: boolean
  canWrite: boolean
  onRestore: (v: DocVersion) => void
}) {
  const session = useEditor()
  const menuRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const label = versionLabel(version)

  if (naming) {
    return (
      <NameField
        initial={version.auto ? label : version.name}
        submitLabel={version.auto ? 'Save' : 'Rename'}
        onSubmit={(name) => nameVersion(session.doc, version.id, name)}
        onCancel={() => setNaming(false)}
      />
    )
  }

  return (
    <div
      className={cx(css.row, !version.auto && css.rowNamed)}
      role="listitem"
      aria-current={active}
      data-testid="version-row"
    >
      <button
        type="button"
        className={css.rowMain}
        title={`Preview “${label}”`}
        onClick={() => previewVersion(session, active ? null : version.id)}
      >
        <span className={css.rowMarker} aria-hidden="true" />
        <span className={css.rowBody}>
          <span className={css.rowTitle}>{label}</span>
          <span className={css.rowMeta}>
            {version.author.kind === 'agent' ? (
              <Avatar size={18} variant="agent" name={version.author.name} />
            ) : (
              <Avatar size={18} name={version.author.name} />
            )}
            <span className={css.rowAuthor}>{version.author.name}</span>
            <span aria-hidden="true">·</span>
            <span>{versionTime(version.createdAt, now)}</span>
          </span>
        </span>
      </button>
      <IconButton
        ref={menuRef}
        label="Version actions"
        size={24}
        radius="sm"
        className={cx(css.rowMenu, menuOpen && css.rowMenuOpen)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <MoreHorizontalIcon size={14} />
      </IconButton>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={menuRef}
        placement="bottom-end"
        width={200}
        aria-label="Version actions"
      >
        <MenuItem onSelect={() => previewVersion(session, version.id)}>Preview</MenuItem>
        <MenuItem disabled={!canWrite} onSelect={() => onRestore(version)}>
          Restore this version
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={!canWrite} onSelect={() => setNaming(true)}>
          {version.auto ? 'Name this version' : 'Rename'}
        </MenuItem>
        {!version.auto && (
          <MenuItem
            destructive
            disabled={!canWrite}
            onSelect={() => removeVersion(session.doc, version.id)}
          >
            Delete
          </MenuItem>
        )}
      </DropdownMenu>
    </div>
  )
}

export function VersionHistoryPanel() {
  const session = useEditor()
  const versions = useVersions()
  const previewId = useEditorState((s) => s.previewVersionId)
  const viewer = useViewer()
  const me = useCommentAuthor()
  const now = useNow()
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState<DocVersion | null>(null)
  const canWrite = !viewer
  const groups = groupVersions(versions, now)

  return (
    <InspectorSection
      title="Version history"
      roomy
      data-testid="history-panel"
      actions={
        <Button
          variant="outline"
          size={26}
          disabled={!canWrite || saving}
          title={canWrite ? undefined : "Viewers can't save versions"}
          onClick={() => setSaving(true)}
        >
          Save version
        </Button>
      }
    >
      {saving && (
        <NameField
          initial=""
          submitLabel="Save"
          onSubmit={(name) => saveVersion(session.doc, me, name) !== null}
          onCancel={() => setSaving(false)}
        />
      )}
      <div className={css.list} role="list">
        <div className={css.row} role="listitem" aria-current={previewId === null}>
          <button
            type="button"
            className={css.rowMain}
            onClick={() => previewVersion(session, null)}
          >
            <span className={cx(css.rowMarker, css.rowMarkerCurrent)} aria-hidden="true" />
            <span className={css.rowBody}>
              <span className={css.rowTitle}>Current version</span>
              <span className={css.rowMeta}>Live · everyone's latest changes</span>
            </span>
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.key} className={css.group} role="group" aria-label={g.title}>
            <div className={css.groupTitle}>{g.title}</div>
            {g.versions.map((v) => (
              <VersionRow
                key={v.id}
                version={v}
                now={now}
                active={v.id === previewId}
                canWrite={canWrite}
                onRestore={setRestoring}
              />
            ))}
          </div>
        ))}
        {versions.length === 0 && (
          <div className={css.empty}>
            No versions yet. Save one to mark a state you can come back to; Baren also keeps
            checkpoints when the file is opened, before restores and before an agent starts editing.
          </div>
        )}
      </div>
      <RestoreConfirm version={restoring} onClose={() => setRestoring(null)} />
    </InspectorSection>
  )
}
