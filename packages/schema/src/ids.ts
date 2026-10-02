import type { TreeID } from 'loro-crdt'
import { SchemaError } from './errors.ts'

const TREE_ID_RE = /^\d+@\d+$/

/** Node ids are Loro `TreeID` strings: `"<counter>@<peer>"`. */
export function isTreeId(value: unknown): value is TreeID {
  return typeof value === 'string' && TREE_ID_RE.test(value)
}

export function asTreeId(value: string): TreeID {
  if (!isTreeId(value))
    throw new SchemaError('invalid-id', `Not a node id: ${JSON.stringify(value)}`)
  return value
}

// ---------------------------------------------------------------------------
// Component keys, node keys, subpath ids (Phase 3)
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const COMPONENT_KEY_RE = /^[0-9a-z]{16}$/
const NODE_KEY_RE = /^[0-9a-z]{10}$/
const SUBPATH_ID_RE = /^[0-9a-z]{8}$/

/** Uniform random index in [0, 36) from crypto (rejection sampling keeps it unbiased). */
function cryptoIndex(): number {
  const buf = new Uint8Array(1)
  for (;;) {
    globalThis.crypto.getRandomValues(buf)
    const b = buf[0] as number
    if (b < 252) return b % 36
  }
}

function randomKey(length: number, random?: () => number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    const index = random ? Math.min(35, Math.floor(random() * 36)) : cryptoIndex()
    out += ALPHABET[index]
  }
  return out
}

/** A new main-component key: 16 chars of `[0-9a-z]`. */
export function newComponentKey(random?: () => number): string {
  return randomKey(16, random)
}

/** A new node key (address inside a main): 10 chars of `[0-9a-z]`. */
export function newNodeKey(random?: () => number): string {
  return randomKey(10, random)
}

/** A new vector subpath id: 8 chars of `[0-9a-z]`. */
export function newSubpathId(random?: () => number): string {
  return randomKey(8, random)
}

export function isComponentKey(v: unknown): v is string {
  return typeof v === 'string' && COMPONENT_KEY_RE.test(v)
}

export function isNodeKey(v: unknown): v is string {
  return typeof v === 'string' && NODE_KEY_RE.test(v)
}

export function isSubpathId(v: unknown): v is string {
  return typeof v === 'string' && SUBPATH_ID_RE.test(v)
}

/** One segment of a virtual id path: a node key or `~<TreeID>` (main node without a key). */
function isPathSegment(segment: string): boolean {
  if (segment.startsWith('~')) return isTreeId(segment.slice(1))
  return isNodeKey(segment)
}

/** True when `path` is a valid override path (`''` = instance root, else `seg(/seg)*`). */
export function isOverridePath(path: string): boolean {
  if (path === '') return true
  for (const segment of path.split('/')) if (!isPathSegment(segment)) return false
  return true
}

/**
 * Split `"<instanceTreeId>/<path>"` into its instance id and override path (`'k1/k2'`).
 * Returns null for plain TreeIDs and malformed ids.
 */
export function parseVirtualId(id: string): { instanceId: string; path: string } | null {
  const slash = id.indexOf('/')
  if (slash <= 0) return null
  const instanceId = id.slice(0, slash)
  const path = id.slice(slash + 1)
  if (!isTreeId(instanceId) || path === '' || !isOverridePath(path)) return null
  return { instanceId, path }
}

/** True for expanded instance content ids (`"<instanceId>/<path>"`). */
export function isVirtualId(id: string): boolean {
  return parseVirtualId(id) !== null
}

/** `"<instanceId>/<path>"`, or the instance id itself for the root path `''`. */
export function virtualId(instanceId: string, path: string): string {
  return path === '' ? instanceId : `${instanceId}/${path}`
}

/** A real node id (TreeID) or a virtual id. */
export function isNodeRef(v: unknown): v is string {
  return typeof v === 'string' && (isTreeId(v) || parseVirtualId(v) !== null)
}

/** Unsigned order of TreeIDs: peer (as an unsigned 64-bit integer), then counter. */
export function compareTreeIds(a: string, b: string): number {
  const [ca = '0', pa = '0'] = a.split('@')
  const [cb = '0', pb = '0'] = b.split('@')
  if (pa !== pb) {
    const x = BigInt(pa)
    const y = BigInt(pb)
    return x < y ? -1 : 1
  }
  return Number(ca) - Number(cb)
}
