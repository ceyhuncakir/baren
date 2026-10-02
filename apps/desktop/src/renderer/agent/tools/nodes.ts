/**
 * Layer tools (contract §6.24–§6.28): set_text_content, rename_nodes, duplicate_nodes,
 * move_nodes, delete_nodes. Per-entry errors in-band; the valid entries are
 * applied in one transaction (origin `agent:<tool>`); the call fails only when none is valid.
 * Locked layers (and layers inside them) are never changed; instance content is changed only
 * through overrides; groups are refitted.
 */
import {
  CONTAINER_NODE_TYPES,
  canReparent,
  duplicateNodes as schemaDuplicate,
  fitGroups,
  getChildIds,
  getNode,
  getParentId,
  isTreeId,
  pasteClipboard,
  removeNodes,
  reparentNodes,
  serializeClipboard,
  setNodeProps,
  setText,
  setTextAt,
  type DesignNode,
  type StylePatch,
} from '@baren/schema'
import { AgentToolError, entryError, type EntryError } from '../errors'
import { UNKNOWN_HEIGHT, toPx } from '../geometry'
import {
  artboardOfRef,
  assertUnlocked,
  childRefs,
  componentName,
  displayName,
  isVirtual,
  pageOfRef,
  requireRef,
  resolveRef,
} from '../model'
import {
  anchorKey,
  arr,
  commit,
  rec,
  type HostEnv,
  type ToolCall,
  type ToolOutput,
} from '../context'
import { placeOnPage } from './write'

function boardsOf(env: HostEnv, ids: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const id of ids) {
    const b = resolveRef(env, id) ? artboardOfRef(env, id) : null
    if (b) out.add(b)
  }
  return out
}

function instanceContent(what: string): AgentToolError {
  return new AgentToolError(
    'instance_content',
    `${what} is inside a component instance: its layers come from the main component. Edit the main component, or detach the instance first.`,
  )
}

// ---------------------------------------------------------------------------
// set_text_content
// ---------------------------------------------------------------------------

export function setTextContent(call: ToolCall): ToolOutput {
  const { env, args } = call
  const errors: EntryError[] = []
  const plan: { id: string; text: string }[] = []
  arr(args, 'updates').forEach((raw, index) => {
    const u = rec(raw)
    const id = typeof u['nodeId'] === 'string' ? u['nodeId'] : ''
    const text = typeof u['textContent'] === 'string' ? u['textContent'] : null
    try {
      const node = requireRef(env, id)
      if (node.type !== 'text') {
        throw new AgentToolError(
          'invalid_target',
          `${componentName(env, node)} "${displayName(env, node)}" is not a text layer; set_text_content only changes Text layers.`,
        )
      }
      if (text === null)
        throw new AgentToolError('invalid_argument', 'textContent must be a string.')
      assertUnlocked(env, id)
      plan.push({ id, text })
    } catch (error) {
      errors.push(entryError(index, id, error))
    }
  })
  // No valid entry: nothing changes; main reports the batch as an error (contract §4.9).
  if (plan.length === 0) return { result: { updated: [], errors } }
  commit(call, () => {
    for (const p of plan) {
      if (isTreeId(p.id)) setText(env.doc, p.id, p.text)
      else setTextAt(env.doc, p.id, p.text, { resolver: env.resolver })
    }
    fitGroups(
      env.doc,
      plan.map((p) => p.id),
      env.geometry.source({ measure: false }),
    )
  })
  const body: Record<string, unknown> = { updated: plan.map((p) => p.id) }
  if (errors.length > 0) body['errors'] = errors
  return {
    result: body,
    touched: [
      ...boardsOf(
        env,
        plan.map((p) => p.id),
      ),
    ],
  }
}

// ---------------------------------------------------------------------------
// rename_nodes
// ---------------------------------------------------------------------------

export const MAX_LAYER_NAME = 50

export function renameNodes(call: ToolCall): ToolOutput {
  const { env, args } = call
  const errors: EntryError[] = []
  const plan: { id: string; name: string }[] = []
  arr(args, 'updates').forEach((raw, index) => {
    const u = rec(raw)
    const id = typeof u['nodeId'] === 'string' ? u['nodeId'] : ''
    try {
      const node = requireRef(env, id)
      if (isVirtual(id)) {
        throw new AgentToolError(
          'instance_content',
          'Layers inside a component instance take their names from the main component; rename the layer in the main component.',
        )
      }
      if (node.type === 'page') {
        throw new AgentToolError('invalid_target', 'Use rename_pages to rename a page.')
      }
      const name = (typeof u['name'] === 'string' ? u['name'] : '').trim().slice(0, MAX_LAYER_NAME)
      if (!name) throw new AgentToolError('invalid_argument', 'A layer name cannot be empty.')
      plan.push({ id, name })
    } catch (error) {
      errors.push(entryError(index, id, error))
    }
  })
  if (plan.length === 0) return { result: { renamed: [], errors } }
  commit(call, () => {
    for (const p of plan) setNodeProps(env.doc, p.id, { name: p.name })
  })
  const body: Record<string, unknown> = { renamed: plan.map((p) => p.id) }
  if (errors.length > 0) body['errors'] = errors
  return {
    result: body,
    touched: [
      ...boardsOf(
        env,
        plan.map((p) => p.id),
      ),
    ],
  }
}

// ---------------------------------------------------------------------------
// duplicate_nodes
// ---------------------------------------------------------------------------

/** Every descendant of `source` → its counterpart in `copy` (parallel walk, same order). */
export function descendantMap(
  env: HostEnv,
  source: string,
  copy: string,
  out: Record<string, string>,
): void {
  const stack: [string, string][] = [[source, copy]]
  for (let pair = stack.pop(); pair !== undefined; pair = stack.pop()) {
    const a = childRefs(env, pair[0])
    const b = childRefs(env, pair[1])
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const from = a[i] as string
      const to = b[i] as string
      out[from] = to
      stack.push([from, to])
    }
  }
}

interface DupEntry {
  index: number
  id: string
  parentId: string | null
}

export function duplicateNodesTool(call: ToolCall): ToolOutput {
  const { env, args } = call
  const errors: EntryError[] = []
  const plan: DupEntry[] = []
  arr(args, 'nodes').forEach((raw, index) => {
    const n = rec(raw)
    const id = typeof n['id'] === 'string' ? n['id'] : ''
    const parentId =
      typeof n['parentId'] === 'string' && n['parentId'] !== '' ? n['parentId'] : null
    try {
      const node = requireRef(env, id)
      if (node.type === 'page') {
        throw new AgentToolError(
          'invalid_target',
          'Pages cannot be duplicated; duplicate their artboards.',
        )
      }
      if (parentId !== null) {
        const parent = requireRef(env, parentId)
        if (isVirtual(parentId)) throw instanceContent('The new parent')
        if (!CONTAINER_NODE_TYPES.has(parent.type)) {
          throw new AgentToolError(
            parent.type === 'instance' ? 'instance_content' : 'invalid_target',
            `${componentName(env, parent)} "${displayName(env, parent)}" cannot contain children.`,
          )
        }
        if (parent.type !== 'page') assertUnlocked(env, parentId)
      } else {
        const real = isTreeId(id) ? id : (id.split('/')[0] as string)
        const p = getParentId(env.doc, real)
        if (p !== null) {
          const pn = getNode(env.doc, p)
          if (pn && pn.type !== 'page') assertUnlocked(env, p)
        }
      }
      plan.push({ index, id, parentId })
    } catch (error) {
      errors.push(entryError(index, id, error))
    }
  })
  if (plan.length === 0) return { result: { duplicates: [], descendantIdMap: {}, errors } }

  const duplicates: { sourceId: string; newId: string; parentId: string }[] = []
  const newBoards: { pageId: string; id: string }[] = []
  commit(call, () => {
    const doc = env.doc
    for (const e of plan) {
      env.geometry.invalidate()
      const geo = env.geometry.source({ measure: true })
      try {
        if (e.parentId === null) {
          const placeRoot = (node: DesignNode): StylePatch | null => {
            const parent = node.parentId === null ? undefined : getNode(doc, node.parentId)
            if (!parent || parent.type !== 'page') return null
            const width = toPx(node.styles['width']) ?? geo.frameOf(node.id)?.width ?? 0
            const height =
              toPx(node.styles['height']) ?? geo.frameOf(node.id)?.height ?? UNKNOWN_HEIGHT
            const at = placeOnPage(call, parent.id, { width, height }, node.id)
            return { left: at.left, top: at.top }
          }
          const ids = schemaDuplicate(doc, [e.id], geo, { placeRoot })
          const newId = ids[0]
          if (newId === undefined) {
            throw new AgentToolError('invalid_target', 'This layer cannot be duplicated in place.')
          }
          const parentId = getParentId(doc, newId) ?? ''
          duplicates.push({ sourceId: e.id, newId, parentId })
          if (getNode(doc, parentId)?.type === 'page')
            newBoards.push({ pageId: parentId, id: newId })
        } else {
          const pageId = pageOfRef(env, e.parentId) ?? ''
          const payload = serializeClipboard(doc, [e.id], {
            geo,
            fileId: env.fileId,
            pageId,
            resolver: env.resolver,
          })
          if (!payload) throw new AgentToolError('invalid_target', 'Nothing to duplicate.')
          const res = pasteClipboard(doc, payload, { parentId: e.parentId, geo })
          if (res.refused === 'cycle') {
            throw new AgentToolError(
              'cycle',
              'This would put a component inside an instance of itself.',
            )
          }
          const newId = res.ids[0]
          if (res.refused !== null || newId === undefined) {
            throw new AgentToolError('invalid_target', 'The layer cannot be added to that parent.')
          }
          duplicates.push({ sourceId: e.id, newId, parentId: e.parentId })
          if (getNode(doc, e.parentId)?.type === 'page') {
            newBoards.push({ pageId: e.parentId, id: newId })
          }
        }
      } catch (error) {
        errors.push(entryError(e.index, e.id, error))
      }
    }
  })
  if (duplicates.length === 0) {
    return { result: { duplicates: [], descendantIdMap: {}, errors } }
  }
  for (const b of newBoards) env.anchors.set(anchorKey(call, b.pageId), b.id)
  const descendantIdMap: Record<string, string> = {}
  for (const d of duplicates) descendantMap(env, d.sourceId, d.newId, descendantIdMap)
  const body: Record<string, unknown> = { duplicates, descendantIdMap }
  if (errors.length > 0) body['errors'] = errors
  const touched = boardsOf(env, [
    ...duplicates.map((d) => d.newId),
    ...duplicates.map((d) => d.sourceId),
  ])
  return { result: body, touched: [...touched] }
}

// ---------------------------------------------------------------------------
// move_nodes
// ---------------------------------------------------------------------------

const REFUSAL_MESSAGES: Record<string, string> = {
  cycle: 'This would put a component inside an instance of itself.',
  'into-self': 'A layer cannot move into itself or one of its descendants.',
  'page-node': 'Pages cannot be moved.',
  virtual: 'Layers inside a component instance cannot be moved; edit the main component.',
}

export function moveNodes(call: ToolCall): ToolOutput {
  const { env, args } = call
  const moves = arr(args, 'moves').map(rec)
  const errors: EntryError[] = []
  const done: { nodeId: string; parentId: string; index: number }[] = []
  const affected = new Set<string>()
  const touched = new Set<string>()
  // Moves apply in order inside one transaction; later moves see earlier ones.
  commit(call, () => {
    const doc = env.doc
    moves.forEach((m, index) => {
      const nodeId = typeof m['nodeId'] === 'string' ? m['nodeId'] : ''
      try {
        const node = requireRef(env, nodeId)
        if (isVirtual(nodeId)) throw instanceContent('This layer')
        if (node.type === 'page')
          throw new AgentToolError('invalid_target', 'Pages cannot be moved.')
        assertUnlocked(env, nodeId)
        let parentId: string
        let index_: number | undefined
        const siblingsWithout = (p: string) => getChildIds(doc, p).filter((c) => c !== nodeId)
        if (typeof m['before'] === 'string' || typeof m['after'] === 'string') {
          const after = typeof m['after'] === 'string'
          const sibId = (after ? m['after'] : m['before']) as string
          const sib = requireRef(env, sibId)
          if (isVirtual(sibId)) throw instanceContent('The sibling')
          if (sib.type === 'page' || sib.parentId === null) {
            throw new AgentToolError('invalid_target', 'A page has no siblings to move next to.')
          }
          if (sibId === nodeId) {
            throw new AgentToolError('invalid_argument', 'A layer cannot move next to itself.')
          }
          parentId = sib.parentId
          const list = siblingsWithout(parentId)
          index_ = list.indexOf(sibId) + (after ? 1 : 0)
        } else if (typeof m['parentId'] === 'string') {
          const raw = m['parentId']
          parentId = raw === 'root' ? (pageOfRef(env, nodeId) ?? '') : raw
          const parent = requireRef(env, parentId)
          if (isVirtual(parentId)) throw instanceContent('The new parent')
          if (parent.type === 'instance') {
            throw new AgentToolError(
              'instance_content',
              'A component instance cannot take children; edit its main component instead.',
            )
          }
          if (!CONTAINER_NODE_TYPES.has(parent.type)) {
            throw new AgentToolError(
              'invalid_target',
              `${componentName(env, parent)} "${displayName(env, parent)}" cannot contain children.`,
            )
          }
          const idx =
            typeof m['index'] === 'number' ? Math.max(0, Math.trunc(m['index'])) : undefined
          const count = siblingsWithout(parentId).length
          index_ = idx === undefined ? count : Math.min(idx, count)
        } else {
          throw new AgentToolError('invalid_argument', 'Each move needs before, after or parentId.')
        }
        const parentNode = getNode(doc, parentId)
        if (parentNode && parentNode.type !== 'page') assertUnlocked(env, parentId)
        const check = canReparent(doc, [nodeId], parentId)
        if (!check.ok) {
          if (check.reason === 'instance-target') {
            throw new AgentToolError('invalid_target', 'That parent cannot contain children.')
          }
          throw new AgentToolError(
            check.reason === 'cycle'
              ? 'cycle'
              : check.reason === 'virtual'
                ? 'instance_content'
                : 'invalid_target',
            REFUSAL_MESSAGES[check.reason] ?? 'This move is not possible.',
          )
        }
        const oldParent = getParentId(doc, nodeId)
        const before = artboardOfRef(env, nodeId)
        if (before) touched.add(before)
        const moved = reparentNodes(
          doc,
          [{ id: nodeId }],
          { parentId, index: index_ },
          env.geometry.source({ measure: true }),
        )
        env.geometry.invalidate()
        if (moved.length === 0)
          throw new AgentToolError('invalid_target', 'This move is not possible.')
        if (oldParent !== null) affected.add(oldParent)
        affected.add(parentId)
        const after = artboardOfRef(env, nodeId)
        if (after) touched.add(after)
        done.push({ nodeId, parentId, index: getChildIds(doc, parentId).indexOf(nodeId) })
      } catch (error) {
        errors.push(entryError(index, nodeId, error))
      }
    })
  })
  if (done.length === 0) return { result: { moves: [], affectedParents: {}, errors } }
  const affectedParents: Record<string, string[]> = {}
  for (const p of affected) {
    if (resolveRef(env, p)) affectedParents[p] = getChildIds(env.doc, p)
  }
  const body: Record<string, unknown> = { moves: done, affectedParents }
  if (errors.length > 0) body['errors'] = errors
  return { result: body, touched: [...touched].filter((b) => resolveRef(env, b)) }
}

// ---------------------------------------------------------------------------
// delete_nodes
// ---------------------------------------------------------------------------

export function deleteNodesTool(call: ToolCall): ToolOutput {
  const { env, args } = call
  const errors: EntryError[] = []
  const valid: string[] = []
  arr(args, 'nodeIds').forEach((raw, index) => {
    const id = typeof raw === 'string' ? raw : ''
    try {
      const node = requireRef(env, id)
      if (node.type === 'page') {
        throw new AgentToolError('invalid_target', 'Pages cannot be deleted with delete_nodes.')
      }
      assertUnlocked(env, id)
      valid.push(id)
    } catch (error) {
      errors.push(entryError(index, id, error))
    }
  })
  if (valid.length === 0) return { result: { deleted: [], hidden: [], errors } }
  const boards = boardsOf(env, valid)
  commit(call, () => {
    removeNodes(env.doc, valid, env.geometry.source({ measure: true }))
  })
  const deleted = valid.filter((id) => isTreeId(id) && !getNode(env.doc, id))
  const hidden = valid.filter((id) => !isTreeId(id))
  const body: Record<string, unknown> = { deleted, hidden }
  if (errors.length > 0) body['errors'] = errors
  return { result: body, touched: [...boards].filter((b) => resolveRef(env, b)) }
}
