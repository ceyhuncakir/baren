/**
 * Tool rail (all editor artboards): select, hand | artboard, rectangle, pen, text, insert |
 * component, image, generate | comment. Canvas tools (pen included) switch the canvas tool; the
 * others are actions: the insert menu, the component picker (32), the image picker; generate is
 * not available yet. Comment toggles comment mode and shows the page's open comment count.
 */
import {
  ArtboardToolIcon,
  CommentIcon,
  ComponentIcon,
  DropdownMenu,
  GenerateToolIcon,
  HandToolIcon,
  ImagePlusIcon,
  InsertToolIcon,
  MenuItem,
  PenToolIcon,
  PointerToolIcon,
  RectangleToolIcon,
  TextAaIcon,
  ToolButton,
  ToolDivider,
  ToolRail,
} from '@baren/ui'
import { memo, useRef, type ReactNode } from 'react'
import { useCommentThreads, useEditor, useEditorState } from '../session/context'
import type { EditorTool } from '../session/store'
import { pickAndInsertImage, runTool, toggleCommentMode } from '../commands/tools'
import { openCount } from '../comments/model'
import { ComponentPicker } from '../components/ComponentPicker'
import commentCss from '../comments/Comments.module.css'

/** The comment tool and the page's open comment count. */
const CommentButton = memo(function CommentButton() {
  const session = useEditor()
  const active = useEditorState((s) => s.commentMode)
  const pageId = useEditorState((s) => s.pageId)
  const viewer = useEditorState((s) => s.self?.role === 'viewer')
  const count = openCount(useCommentThreads(), pageId)
  const label = count > 0 ? `Comments, ${count} open` : 'Comments'
  const button = (
    <ToolButton
      label={label}
      shortcut="C"
      active={active}
      disabled={viewer}
      className={commentCss.railButton}
      onClick={() => toggleCommentMode(session)}
    >
      <CommentIcon size={16} />
      {count > 0 && (
        <span className={commentCss.railBadge} aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </ToolButton>
  )
  // A disabled button gets no pointer events: the wrapper carries the explanation.
  return viewer ? (
    <span className={commentCss.railDisabled} title="Viewers can't comment">
      {button}
    </span>
  ) : (
    button
  )
})

interface ToolDef {
  id: EditorTool
  label: string
  shortcut: string
  icon: ReactNode
}

const TOOLS_1: ToolDef[] = [
  { id: 'select', label: 'Select', shortcut: 'V', icon: <PointerToolIcon size={16} /> },
  { id: 'hand', label: 'Hand', shortcut: 'H', icon: <HandToolIcon size={16} /> },
]
const TOOLS_2: ToolDef[] = [
  { id: 'artboard', label: 'Artboard', shortcut: 'A', icon: <ArtboardToolIcon size={16} /> },
  { id: 'rectangle', label: 'Rectangle', shortcut: 'R', icon: <RectangleToolIcon size={16} /> },
  { id: 'pen', label: 'Pen', shortcut: 'P', icon: <PenToolIcon size={16} /> },
  { id: 'text', label: 'Text', shortcut: 'T', icon: <TextAaIcon size={15} /> },
]
const TOOLS_3: ToolDef[] = [
  { id: 'component', label: 'Component', shortcut: 'K', icon: <ComponentIcon size={16} /> },
  { id: 'image', label: 'Image', shortcut: 'Shift+I', icon: <ImagePlusIcon size={16} /> },
  { id: 'generate', label: 'Generate', shortcut: 'G', icon: <GenerateToolIcon size={16} /> },
]

export const EditorToolRail = memo(function EditorToolRail() {
  const session = useEditor()
  const tool = useEditorState((s) => s.tool)
  const insertRef = useRef<HTMLButtonElement>(null)
  const insertOpen = useEditorState((s) => s.insertOpen)
  const pickerOpen = useEditorState((s) => s.componentPickerOpen)
  // Editing a vector's points is pen work: the rail shows the pen (30).
  const editingVector = useEditorState((s) => s.editingVectorId !== null)
  const activeTool = editingVector ? 'pen' : tool
  const componentRef = useRef<HTMLButtonElement>(null)
  const setInsertOpen = (open: boolean) => session.store.setState({ insertOpen: open })

  const button = (t: ToolDef) => {
    const picker = t.id === 'component'
    return (
      <ToolButton
        key={t.id}
        ref={picker ? componentRef : undefined}
        label={t.label}
        shortcut={t.shortcut}
        active={picker ? pickerOpen : activeTool === t.id}
        {...(picker ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': pickerOpen } : {})}
        onClick={() => runTool(session, t.id)}
      >
        {t.icon}
      </ToolButton>
    )
  }

  return (
    <ToolRail aria-label="Tools">
      {TOOLS_1.map(button)}
      <ToolDivider />
      {TOOLS_2.map(button)}
      <ToolButton
        ref={insertRef}
        label="Insert"
        shortcut="I"
        active={insertOpen}
        aria-haspopup="menu"
        aria-expanded={insertOpen}
        onClick={() => setInsertOpen(!insertOpen)}
      >
        <InsertToolIcon size={16} />
      </ToolButton>
      <ToolDivider />
      {TOOLS_3.map(button)}
      <ToolDivider />
      <CommentButton />
      <ComponentPicker anchorRef={componentRef} />
      <DropdownMenu
        open={insertOpen}
        onOpenChange={setInsertOpen}
        anchorRef={insertRef}
        placement="right-start"
        offset={6}
        width={200}
        aria-label="Insert"
      >
        <MenuItem shortcut="A" onSelect={() => runTool(session, 'artboard')}>
          Artboard
        </MenuItem>
        <MenuItem shortcut="R" onSelect={() => runTool(session, 'rectangle')}>
          Rectangle
        </MenuItem>
        <MenuItem shortcut="T" onSelect={() => runTool(session, 'text')}>
          Text
        </MenuItem>
        <MenuItem shortcut="Shift+I" onSelect={() => void pickAndInsertImage(session)}>
          Image…
        </MenuItem>
      </DropdownMenu>
    </ToolRail>
  )
})
