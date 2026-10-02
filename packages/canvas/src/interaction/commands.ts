import type { LoroDoc } from 'loro-crdt'
import {
  duplicateNodes,
  removeNodes,
  type ComponentResolver,
  type GeometrySource,
  type StylePatch,
  type StyleValue,
} from '@baren/schema'
import {
  DUPLICATE_GAP,
  ORIGIN,
  commitGeometry,
  commitReorder,
  geometryValue,
  type GeometryPatch,
} from '../doc/ops.ts'
import { readStyleValues } from '../doc/read.ts'
import { deltaInParent } from '../math/frame.ts'
import { escapeSelection, normalizeSelection } from '../math/selection.ts'
import { isVirtualRef } from '../render/scene.ts'
import type { SceneManager } from '../render/sceneManager.ts'
import { isAbsolutelyPositioned, pxValue } from '../render/styles.ts'
import type { CanvasController } from '../types.ts'
import type { KeyCommand } from './keyboard.ts'

/** Selected nodes that edits apply to: no descendants of selected nodes, nothing locked. */
export function editableSelection(scenes: SceneManager, selection: readonly string[]): string[] {
  return normalizeSelection(selection, (id) => scenes.parentOf(id)).filter(
    (id) => scenes.info(id)?.locked !== true,
  )
}

/**
 * Move nodes by (dx, dy) in one undo step: artboards and absolutely positioned
 * layers change left/top (in their parent's axes; instance content as overrides);
 * in-flow layers move one slot among their siblings. Positions are read from Loro
 * (the rendered mirror catches up a frame later). Enclosing groups are refitted.
 */
export function nudgeNodes(
  doc: LoroDoc,
  scenes: SceneManager,
  ids: readonly string[],
  dx: number,
  dy: number,
  opts: { geo?: GeometrySource; resolver?: ComponentResolver } = {},
): void {
  const patches: GeometryPatch[] = []
  for (const id of ids) {
    const info = scenes.info(id)
    if (!info) continue
    const virtual = isVirtualRef(id)
    if (info.isTop || isAbsolutelyPositioned(info.styles)) {
      const cur = virtual ? info.styles : readStyleValues(doc, id, ['left', 'top'])
      const left = pxValue(cur['left'])
      const top = pxValue(cur['top'])
      const parentRot = info.isTop ? 0 : (scenes.frameOf(info.parentId ?? '')?.rotation ?? 0)
      const d = deltaInParent(dx, dy, parentRot)
      const p: GeometryPatch = { id }
      if (left !== null || info.isTop) p.left = Math.round(((left ?? 0) + d.x) * 100) / 100
      if (top !== null || info.isTop) p.top = Math.round(((top ?? 0) + d.y) * 100) / 100
      patches.push(p)
    } else if (info.parentId && !virtual) {
      const siblings = scenes.info(info.parentId)?.children ?? []
      const index = siblings.indexOf(id)
      const next = index + (dx + dy < 0 ? -1 : 1)
      if (index >= 0 && next >= 0 && next < siblings.length) {
        commitReorder(doc, [id], info.parentId, next, ORIGIN.nudge)
      }
    }
  }
  if (patches.length > 0)
    commitGeometry(doc, patches, ORIGIN.nudge, {
      ...opts,
      current: (id) => (scenes.info(id)?.styles as Record<string, StyleValue>) ?? null,
    })
}

/**
 * Duplicate nodes (schema `duplicateNodes`: same deep-copy rules as paste; instance content is
 * copied detached); artboards are placed to the right of the original. Returns the copies.
 */
export function duplicate(
  doc: LoroDoc,
  scenes: SceneManager,
  pageId: string,
  ids: readonly string[],
  geo: GeometrySource,
): string[] {
  return duplicateNodes(doc, ids, geo, {
    origin: ORIGIN.duplicate,
    placeRoot: (node) => {
      if (node.parentId !== pageId) return null
      const b = scenes.boundsOf(node.id)
      if (!b) return null
      const styles: StylePatch = {
        left: geometryValue(node.styles['left'], b.x + b.width + DUPLICATE_GAP),
      }
      return styles
    },
  })
}

/** Delete real nodes, hide instance content (override), refit and drop emptied groups. */
export function remove(doc: LoroDoc, ids: readonly string[], geo: GeometrySource): void {
  removeNodes(doc, ids, geo, { origin: ORIGIN.delete })
}

/** What a key command may drive (the controller plus a few internals). */
export interface CommandTarget extends Pick<
  CanvasController,
  | 'getTool'
  | 'setTool'
  | 'isReadOnly'
  | 'getSelection'
  | 'getPageId'
  | 'nudge'
  | 'deleteSelection'
  | 'duplicateSelection'
  | 'selectAll'
  | 'editText'
  | 'editVector'
  | 'undo'
  | 'redo'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomTo'
  | 'zoomToFit'
  | 'zoomToSelection'
> {
  readonly scenes: SceneManager
  setSelection(ids: readonly string[]): void
}

/** Execute a keyboard command; returns false when it does not apply. */
export function runKeyCommand(cmd: KeyCommand, t: CommandTarget): boolean {
  const selection = t.getSelection()
  const readOnly = t.isReadOnly()
  const parentOf = (id: string): string | null => t.scenes.parentOf(id)
  switch (cmd.kind) {
    case 'tool':
      if (readOnly && cmd.tool !== 'select' && cmd.tool !== 'hand') return false
      t.setTool(cmd.tool)
      return true
    case 'nudge':
      if (readOnly || selection.length === 0) return false
      t.nudge(cmd.dx, cmd.dy)
      return true
    case 'delete':
      if (readOnly || selection.length === 0) return false
      t.deleteSelection()
      return true
    case 'duplicate':
      if (readOnly || selection.length === 0) return false
      t.duplicateSelection()
      return true
    case 'escape':
      if (t.getTool() !== 'select') t.setTool('select')
      else if (selection.length > 0)
        t.setSelection(escapeSelection(selection, parentOf, t.getPageId()))
      else return false
      return true
    case 'selectParent':
      if (selection.length === 0) return false
      t.setSelection(escapeSelection(selection, parentOf, t.getPageId()))
      return true
    case 'enter': {
      if (selection.length !== 1) return false
      const id = selection[0] as string
      const info = t.scenes.info(id)
      if (!info) return false
      if (info.type === 'text' && !readOnly) t.editText(id)
      else if (info.type === 'vector' && !readOnly && !isVirtualRef(id)) t.editVector(id)
      else if (info.children.length > 0) t.setSelection([...info.children])
      else return false
      return true
    }
    case 'selectAll':
      t.selectAll()
      return true
    case 'undo':
      return t.undo()
    case 'redo':
      return t.redo()
    case 'zoomIn':
      t.zoomIn()
      return true
    case 'zoomOut':
      t.zoomOut()
      return true
    case 'zoom100':
      t.zoomTo(1)
      return true
    case 'zoomFit':
      t.zoomToFit()
      return true
    case 'zoomSelection':
      t.zoomToSelection()
      return true
  }
}
