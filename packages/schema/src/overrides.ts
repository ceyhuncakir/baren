/**
 * Writing through a node ref (contract §2.7.3, §4.7): a real id writes the node; a virtual id
 * (`"<instanceId>/<path>"`) writes that instance's override entry; on an instance root, own
 * keys (placement + size) go to its `styles` and every other key to `overrides['']`.
 *
 * Overrides keep only real differences: a value equal to the effective base value (main +
 * overrides stored on nested instances) removes the override key; `null` stores a `null`
 * ("removed in this instance") when the base has the property and removes the override
 * otherwise. Override entries and their `styles` maps are cleared, never deleted, because
 * Loro resurfaces the old state of a re-ensured mergeable child.
 */
import { LoroMap, type LoroDoc } from 'loro-crdt'
import { decodeOverrideEntry, decodeOverrides } from './decode.ts'
import { nodesTree } from './doc.ts'
import { SchemaError } from './errors.ts'
import { isTreeId, parseVirtualId } from './ids.ts'
import { applyStyle, nodeTypeOf, requireNode, setNodeProps, setText, stylesMapOf } from './nodes.ts'
import { baseNodeOf, type ComponentResolver } from './resolve.ts'
import {
  NODE_KEY,
  PLACEMENT_KEYS,
  isInstanceOwnKey,
  type NodePropsPatch,
  type OverrideEntry,
  type StylePatch,
  type StyleValue,
  type Styles,
} from './types.ts'
import { run } from './util.ts'

export interface WriteAtOptions {
  origin?: string
  resolver?: ComponentResolver
}

const ENTRY_FIELDS = ['text', 'hidden', 'assetId', 'assetName'] as const

/** The instance's overrides map (created mergeable when missing). */
function overridesMap(doc: LoroDoc, instanceId: string): LoroMap {
  const node = requireNode(nodesTree(doc), instanceId)
  if (nodeTypeOf(node) !== 'instance') {
    throw new SchemaError('invalid-ref', `Node ${instanceId} is not an instance`)
  }
  const existing = node.data.get(NODE_KEY.overrides)
  return existing instanceof LoroMap ? existing : node.data.ensureMergeableMap(NODE_KEY.overrides)
}

function existingEntry(map: LoroMap, path: string): LoroMap | undefined {
  const e = map.get(path)
  return e instanceof LoroMap ? e : undefined
}

function entryStyles(entry: LoroMap): LoroMap {
  const s = entry.get('styles')
  return s instanceof LoroMap ? s : entry.ensureMergeableMap('styles')
}

function requireVirtual(doc: LoroDoc, ref: string): { instanceId: string; path: string } {
  const v = parseVirtualId(ref)
  if (!v) throw new SchemaError('invalid-ref', `Not a node ref: ${JSON.stringify(ref)}`)
  const node = requireNode(nodesTree(doc), v.instanceId)
  if (nodeTypeOf(node) !== 'instance') {
    throw new SchemaError('invalid-ref', `Node ${v.instanceId} is not an instance`)
  }
  return v
}

/** Write style overrides for `path` against the base styles. */
function writeOverrideStyles(
  doc: LoroDoc,
  instanceId: string,
  path: string,
  patch: StylePatch,
  base: Styles,
): void {
  const map = overridesMap(doc, instanceId)
  let entry = existingEntry(map, path)
  let styles = entry ? (entry.get('styles') as unknown) : undefined
  for (const key in patch) {
    const v = patch[key]
    if (v === undefined) continue
    const current = styles instanceof LoroMap ? (styles.get(key) as StyleValue | null) : undefined
    const remove = v === null ? !(key in base) : base[key] === v
    if (remove) {
      if (current !== undefined && styles instanceof LoroMap) styles.delete(key)
      continue
    }
    if (current === v) continue
    if (v !== null && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) {
      throw new SchemaError('invalid-type', `Style ${key} must be a string or finite number`)
    }
    entry ??= map.ensureMergeableMap(path)
    if (!(styles instanceof LoroMap)) styles = entryStyles(entry)
    ;(styles as LoroMap).set(key, v)
  }
}

/** Write one scalar override field (`undefined`/`null` or equal to base → removed). */
function writeOverrideField(
  doc: LoroDoc,
  instanceId: string,
  path: string,
  field: (typeof ENTRY_FIELDS)[number],
  value: string | boolean | null,
  base: unknown,
): void {
  const map = overridesMap(doc, instanceId)
  const entry = existingEntry(map, path)
  const current = entry?.get(field)
  if (value === null || value === base) {
    if (entry && current !== undefined) entry.delete(field)
    return
  }
  if (current === value) return
  ;(entry ?? map.ensureMergeableMap(path)).set(field, value)
}

/** Patch styles of a real or virtual node (instance roots split own keys / overrides). */
export function setStylesAt(
  doc: LoroDoc,
  ref: string,
  patch: StylePatch,
  opts: WriteAtOptions = {},
): void {
  run(doc, opts.origin, () => {
    if (isTreeId(ref)) {
      const node = requireNode(nodesTree(doc), ref)
      const styles = stylesMapOf(node)
      if (nodeTypeOf(node) !== 'instance') {
        for (const key in patch) {
          const v = patch[key]
          if (v !== undefined) applyStyle(styles, key, v)
        }
        return
      }
      const rest: StylePatch = {}
      let hasRest = false
      for (const key in patch) {
        const v = patch[key]
        if (v === undefined) continue
        if (isInstanceOwnKey(key)) applyStyle(styles, key, v)
        else {
          rest[key] = v
          hasRest = true
        }
      }
      if (hasRest) {
        const base = baseNodeOf(doc, ref, '', opts.resolver)
        writeOverrideStyles(doc, ref, '', rest, base?.styles ?? {})
      }
      return
    }
    const v = requireVirtual(doc, ref)
    const base = baseNodeOf(doc, v.instanceId, v.path, opts.resolver)
    writeOverrideStyles(doc, v.instanceId, v.path, patch, base?.styles ?? {})
  })
}

/** Replace the text of a real text node, or override it on a virtual one. */
export function setTextAt(
  doc: LoroDoc,
  ref: string,
  text: string,
  opts: WriteAtOptions = {},
): void {
  run(doc, opts.origin, () => {
    if (isTreeId(ref)) {
      setText(doc, ref, text)
      return
    }
    const v = requireVirtual(doc, ref)
    const base = baseNodeOf(doc, v.instanceId, v.path, opts.resolver)
    if (base && base.type !== 'text') {
      throw new SchemaError('invalid-type', `Node ${ref} is a ${base.type}, not text`)
    }
    writeOverrideField(doc, v.instanceId, v.path, 'text', text, base?.text)
  })
}

/**
 * Patch props of a real node (`setNodeProps`), or override `hidden` / `assetId` / `assetName`
 * of a virtual one (`name` and `locked` are ignored on virtual nodes).
 */
export function setPropsAt(
  doc: LoroDoc,
  ref: string,
  patch: Pick<NodePropsPatch, 'hidden' | 'locked' | 'name' | 'assetId' | 'assetName'>,
  opts: WriteAtOptions = {},
): void {
  run(doc, opts.origin, () => {
    if (isTreeId(ref)) {
      setNodeProps(doc, ref, patch)
      return
    }
    const v = requireVirtual(doc, ref)
    const base = baseNodeOf(doc, v.instanceId, v.path, opts.resolver)
    for (const field of ['hidden', 'assetId', 'assetName'] as const) {
      const value = patch[field]
      if (value === undefined) continue
      const b = field === 'hidden' ? (base?.hidden ?? false) : base?.[field]
      writeOverrideField(doc, v.instanceId, v.path, field, value, b)
    }
  })
}

/** Delete keys of an override entry (all, or only `keys`); the entry itself stays. */
function clearEntry(entry: LoroMap, keys: readonly string[] | undefined): void {
  const styles = entry.get('styles')
  if (styles instanceof LoroMap) {
    for (const k of styles.keys()) if (!keys || keys.includes(k)) styles.delete(k)
  }
  for (const field of ENTRY_FIELDS) {
    if ((!keys || keys.includes(field)) && entry.get(field) !== undefined) entry.delete(field)
  }
}

export interface ResetOverridesOptions {
  /** Virtual refs: also clear the entries below this path (nested instance content). */
  deep?: boolean
  /** Only these style keys (and/or the fields `text`, `hidden`, `assetId`, `assetName`). */
  keys?: readonly string[]
  origin?: string
}

/**
 * Reset an instance (every override entry cleared, size keys dropped so it follows the main
 * again) or one virtual node's entry (`deep`: and the entries below it).
 */
export function resetOverrides(doc: LoroDoc, ref: string, opts: ResetOverridesOptions = {}): void {
  run(doc, opts.origin ?? 'editor:reset-overrides', () => {
    if (isTreeId(ref)) {
      const node = requireNode(nodesTree(doc), ref)
      if (nodeTypeOf(node) !== 'instance') return
      const map = overridesMap(doc, ref)
      for (const path of map.keys()) {
        if (opts.keys && path !== '') continue
        const entry = existingEntry(map, path)
        if (entry) clearEntry(entry, opts.keys)
      }
      const styles = stylesMapOf(node)
      for (const key of styles.keys()) {
        if (PLACEMENT_KEYS.has(key)) continue
        if (!opts.keys || opts.keys.includes(key)) styles.delete(key)
      }
      return
    }
    const v = requireVirtual(doc, ref)
    const map = overridesMap(doc, v.instanceId)
    for (const path of map.keys()) {
      if (path !== v.path && !(opts.deep && path.startsWith(`${v.path}/`))) continue
      const entry = existingEntry(map, path)
      if (entry) clearEntry(entry, opts.keys)
    }
  })
}

/** An instance's overrides (empty entries omitted). */
export function getOverrides(doc: LoroDoc, instanceId: string): Record<string, OverrideEntry> {
  const node = requireNode(nodesTree(doc), instanceId)
  return decodeOverrides(overridesJson(node.data)) ?? {}
}

function overridesJson(data: LoroMap): unknown {
  const o = data.get(NODE_KEY.overrides)
  return o instanceof LoroMap ? o.toJSON() : undefined
}

/** True when an instance (or the virtual node `ref`) has any override. */
export function hasOverrides(doc: LoroDoc, ref: string): boolean {
  if (isTreeId(ref)) {
    const node = requireNode(nodesTree(doc), ref)
    if (nodeTypeOf(node) !== 'instance') return false
    if (Object.keys(decodeOverrides(overridesJson(node.data)) ?? {}).length > 0) return true
    return stylesMapOf(node)
      .keys()
      .some((k) => !PLACEMENT_KEYS.has(k))
  }
  const v = parseVirtualId(ref)
  if (!v) return false
  const node = requireNode(nodesTree(doc), v.instanceId)
  const o = node.data.get(NODE_KEY.overrides)
  if (!(o instanceof LoroMap)) return false
  const entry = o.get(v.path)
  return entry instanceof LoroMap && decodeOverrideEntry(entry.toJSON()) !== undefined
}
