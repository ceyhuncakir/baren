/**
 * Left panel: file header (mark → back to files, double-click name → rename, panel
 * toggle), Design/Theme switch, then Pages + Layers (design) or the token list (theme).
 */
import {
  EditorPanel,
  FooterLinks,
  IconButton,
  LogoMark,
  PanelHeader,
  PanelLeftIcon,
  PanelModeSwitch,
  Segmented,
} from '@baren/ui'
import { setDocName, transact } from '@baren/schema'
import { useEffect, useRef, useState } from 'react'
import { bridge } from '../lib/bridge'
import { SITE_URL } from './lib/env'
import { ComponentsSection } from './components/ComponentsSection'
import { LayersPanel } from './layers/LayersPanel'
import { PagesSection } from './layers/PagesSection'
import { useComponents, useDocName, useEditor, useEditorState } from './session/context'
import type { PanelMode } from './session/store'
import { ThemePanel } from './theme/ThemePanel'
import css from './Editor.module.css'

const MODES = [
  { value: 'design' as const, label: 'Design' },
  { value: 'theme' as const, label: 'Theme' },
]

const FOOTER_LINKS = [
  { label: "What's new", onClick: () => void bridge.shell.openExternal(`${SITE_URL}/changelog`) },
  { label: 'Feedback', onClick: () => void bridge.shell.openExternal(`${SITE_URL}/feedback`) },
]

export function LeftPanel() {
  const { store } = useEditor()
  const mode = useEditorState((s) => s.mode)
  const hasComponents = useComponents().list.length > 0
  return (
    <EditorPanel side="left" aria-label="Layers and pages">
      <FileHeader />
      <PanelModeSwitch>
        <Segmented<PanelMode>
          fullWidth
          value={mode}
          onChange={(m) => store.setState({ mode: m })}
          options={MODES}
        />
      </PanelModeSwitch>
      {mode === 'design' ? (
        <div className={css.leftScroll}>
          <PagesSection />
          <ComponentsSection />
          <LayersPanel header={hasComponents} />
        </div>
      ) : (
        <ThemePanel />
      )}
      <FooterLinks className={css.footer} links={FOOTER_LINKS} />
    </EditorPanel>
  )
}

export function PanelToggle({ floating = false }: { floating?: boolean }) {
  const { store } = useEditor()
  const open = useEditorState((s) => s.leftPanelOpen)
  return (
    <IconButton
      label={open ? 'Hide left panel' : 'Show left panel'}
      size={26}
      radius="sm"
      className={floating ? css.panelToggleFloating : undefined}
      onClick={() => store.setState({ leftPanelOpen: !open })}
    >
      <PanelLeftIcon size={15} />
    </IconButton>
  )
}

function FileHeader() {
  const session = useEditor()
  const docName = useDocName()
  const name = docName || session.file?.name || 'Untitled'
  const [editing, setEditing] = useState(false)
  return (
    <PanelHeader
      leading={
        <button
          type="button"
          className={css.markButton}
          title="Back to files"
          aria-label="Back to files"
          onClick={() => session.exit()}
        >
          <LogoMark />
        </button>
      }
      title={
        editing ? (
          <FileNameInput
            name={name}
            onDone={(next) => {
              setEditing(false)
              if (next === null) return
              transact(session.doc, () => setDocName(session.doc, next), {
                origin: 'editor:rename',
              })
              void bridge.files.rename(session.fileId, next).catch(() => undefined)
            }}
          />
        ) : (
          <button
            type="button"
            className={css.fileHeaderTitle}
            title="Double-click to rename"
            onDoubleClick={() => setEditing(true)}
          >
            {name}
          </button>
        )
      }
      trailing={<PanelToggle />}
    />
  )
}

function FileNameInput({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    ref.current?.select()
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    const v = ref.current?.value.trim() ?? ''
    onDone(commit && v !== '' && v !== name ? v : null)
  }
  return (
    <input
      ref={ref}
      className={css.fileNameInput}
      defaultValue={name}
      aria-label="File name"
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}
