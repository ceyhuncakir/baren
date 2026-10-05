/**
 * Version history: named and automatic checkpoints of a file. Each version records the
 * document's frontiers when it was taken, so any version can be shown (`docAtVersion`, a fork,
 * never a checkout of the live doc) and restored, as long as the document keeps its full history
 * (it does: every snapshot the core, the sync client and the server export is a full snapshot,
 * never a shallow one).
 *
 * ```
 * versions: LoroMap
 *   <versionId>: mergeable LoroMap {
 *     name: string                 "" for unnamed automatic checkpoints
 *     createdAt: number            epoch ms
 *     authorId, authorName: string, authorKind: 'user' | 'agent'
 *     frontiers: Uint8Array        encodeFrontiers(doc.frontiers()) before the entry was written
 *     auto: boolean                automatic checkpoints are pruned (MAX_AUTO_VERSIONS)
 *     reason: 'manual' | 'session' | 'agent' | 'restore'
 *   }
 * ```
 *
 * Restoring makes the design (nodes, tokens, components, meta) equal to the version's as one new
 * change, so it syncs to collaborators and undoes like any edit; comments and the version list
 * itself are left as they are now. Version entries are written with a `version:` origin, which
 * design undo excludes.
 */
import { LoroMap, decodeFrontiers, encodeFrontiers, type Frontiers, type LoroDoc } from 'loro-crdt'
import type { CommentAuthor } from './comments.ts'
import { autoCommit, versionsMap } from './doc.ts'
import { SchemaError } from './errors.ts'
import { newCommentId } from './ids.ts'
import { CONTAINER } from './types.ts'

export type VersionReason = 'manual' | 'session' | 'agent' | 'restore'

export interface DocVersion {
  id: string
  /** "" for an unnamed automatic checkpoint. */
  name: string
  createdAt: number
  author: CommentAuthor
  frontiers: Frontiers
  auto: boolean
  reason: VersionReason
}

/** Automatic checkpoints kept per file (named versions are never pruned). */
export const MAX_AUTO_VERSIONS = 50
export const MAX_VERSION_NAME = 200
/** Root containers a restore leaves as they are. */
const KEPT_ROOTS: ReadonlySet<string> = new Set([CONTAINER.comments, CONTAINER.versions])
const REASONS: ReadonlySet<string> = new Set(['manual', 'session', 'agent', 'restore'])

function invalid(message: string): never {
  throw new SchemaError('invalid-version', message)
}

function checkName(name: string, auto: boolean): string {
  const text = name.trim()
  if (text === '' && !auto) invalid('A version needs a name')
  if (text.length > MAX_VERSION_NAME)
    invalid(`Version names are at most ${MAX_VERSION_NAME} characters`)
  return text
}

function entryOf(doc: LoroDoc, id: string): LoroMap {
  const entry = versionsMap(doc).get(id)
  if (!(entry instanceof LoroMap)) {
    throw new SchemaError('version-not-found', `Version not found: ${id}`)
  }
  return entry
}

function decodeVersion(id: string, raw: unknown): DocVersion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  const bytes = v['frontiers']
  if (!(bytes instanceof Uint8Array)) return null
  let frontiers: Frontiers
  try {
    frontiers = decodeFrontiers(bytes)
  } catch {
    return null
  }
  const authorId = typeof v['authorId'] === 'string' && v['authorId'] !== '' ? v['authorId'] : null
  const reason =
    typeof v['reason'] === 'string' && REASONS.has(v['reason']) ? v['reason'] : 'manual'
  return {
    id,
    name: typeof v['name'] === 'string' ? v['name'] : '',
    createdAt: typeof v['createdAt'] === 'number' ? v['createdAt'] : 0,
    author: {
      id: authorId ?? 'unknown',
      name:
        typeof v['authorName'] === 'string' && v['authorName'] !== '' ? v['authorName'] : 'Someone',
      kind: v['authorKind'] === 'agent' ? 'agent' : 'user',
    },
    frontiers,
    auto: v['auto'] === true,
    reason: reason as VersionReason,
  }
}

/** Every version, newest first. */
export function getVersions(doc: LoroDoc): DocVersion[] {
  const json = versionsMap(doc).toJSON() as Record<string, unknown>
  return Object.entries(json)
    .map(([id, raw]) => decodeVersion(id, raw))
    .filter((v): v is DocVersion => v !== null)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
}

export function getVersion(doc: LoroDoc, id: string): DocVersion | undefined {
  const entry = versionsMap(doc).get(id)
  if (!(entry instanceof LoroMap)) return undefined
  return decodeVersion(id, entry.toJSON()) ?? undefined
}

/**
 * Record the document as it is now. Call it outside other transactions (or after their
 * changes), so the frontiers cover them. Automatic checkpoints beyond MAX_AUTO_VERSIONS are
 * pruned, oldest first. Returns the version id.
 */
export function createVersion(
  doc: LoroDoc,
  input: {
    name: string
    author: CommentAuthor
    auto?: boolean
    reason?: VersionReason
    now?: number
  },
): string {
  const auto = input.auto === true
  const name = checkName(input.name, auto)
  if (input.author.id === '' || input.author.name === '') invalid('A version needs an author')
  const frontiers = encodeFrontiers(doc.frontiers())
  const id = newCommentId()
  const entry = versionsMap(doc).ensureMergeableMap(id)
  entry.set('name', name)
  entry.set('createdAt', input.now ?? Date.now())
  entry.set('authorId', input.author.id)
  entry.set('authorName', input.author.name)
  entry.set('authorKind', input.author.kind)
  entry.set('frontiers', frontiers)
  entry.set('auto', auto)
  entry.set('reason', input.reason ?? (auto ? 'session' : 'manual'))
  if (auto) pruneAutoVersions(doc)
  autoCommit(doc)
  return id
}

function pruneAutoVersions(doc: LoroDoc): void {
  const autos = getVersions(doc).filter((v) => v.auto)
  const map = versionsMap(doc)
  for (const old of autos.slice(MAX_AUTO_VERSIONS)) map.delete(old.id)
}

/** Name a version (naming an automatic checkpoint keeps it: named versions are never pruned). */
export function renameVersion(doc: LoroDoc, id: string, name: string): void {
  const entry = entryOf(doc, id)
  const text = checkName(name, false)
  if (entry.get('name') === text && entry.get('auto') === false) return
  entry.set('name', text)
  entry.set('auto', false)
  autoCommit(doc)
}

export function deleteVersion(doc: LoroDoc, id: string): void {
  const map = versionsMap(doc)
  if (map.get(id) === undefined) return
  map.delete(id)
  autoCommit(doc)
}

function sameFrontiers(a: Frontiers, b: Frontiers): boolean {
  if (a.length !== b.length) return false
  const key = (f: Frontiers) =>
    f
      .map((x) => `${x.peer}:${x.counter}`)
      .sort()
      .join(',')
  return key(a) === key(b)
}

/** The doc as it was at a version: a fork (edits to it never reach the live doc). */
export function docAtVersion(doc: LoroDoc, version: Pick<DocVersion, 'frontiers'>): LoroDoc {
  return doc.forkAt(version.frontiers)
}

/** The design changes (everything but comments and versions) from `from` to `to`. */
function designDiff(doc: LoroDoc, from: Frontiers, to: Frontiers): ReturnType<LoroDoc['diff']> {
  const diff = doc.diff(from, to, false)
  let fork: LoroDoc | null = null
  return diff.filter(([cid]) => {
    let path = doc.getPathToContainer(cid)
    if (path === undefined) {
      // A container that only exists on the other side (deleted since): look it up there.
      fork ??= doc.forkAt(to)
      path = fork.getPathToContainer(cid)
    }
    const root = path?.[0]
    if (typeof root === 'string') return !KEPT_ROOTS.has(root)
    // Unresolvable on both sides: mergeable children name their parent root in their id.
    return ![...KEPT_ROOTS].some((r) => cid.includes(`root-${r}:`) || cid.includes(`$${r}>`))
  })
}

/** True when the design changed since the version (comments and versions do not count). */
export function changedSinceVersion(doc: LoroDoc, version: Pick<DocVersion, 'frontiers'>): boolean {
  const now = doc.frontiers()
  if (sameFrontiers(now, version.frontiers)) return false
  return designDiff(doc, version.frontiers, now).length > 0
}

/**
 * Make the design equal to the version's as a new change on top of the current one (nodes,
 * tokens, components and meta; comments and versions stay as they are). Returns false when
 * nothing differed. Wrap it in `transact` with an undoable origin: it is one undo step.
 *
 * Layers deleted since the version come back under new ids (Loro re-creates deleted tree
 * nodes), so the result is equivalent to the version, not id-identical: comments pinned on such
 * a layer fall back to their saved page position.
 */
export function restoreVersion(doc: LoroDoc, version: Pick<DocVersion, 'frontiers'>): boolean {
  if (doc.isDetached()) throw new SchemaError('loro', 'Cannot restore into a detached document')
  const diff = designDiff(doc, doc.frontiers(), version.frontiers)
  if (diff.length === 0) return false
  doc.applyDiff(diff, { fullState: true })
  autoCommit(doc)
  return true
}
