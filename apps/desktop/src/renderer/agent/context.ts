/**
 * What an executor gets (contract §11): the host's document and helpers (`HostEnv`, built from
 * an editor session by `host/attach.ts`, or directly from a Loro doc in unit tests) and the
 * request (`ToolCall`: validated arguments, the calling agent, main's pre-resolved image
 * sources and the cancellation signal). Writes go through `commit`: one Loro transaction with
 * origin `agent:<tool>`, so one sync update and one undo step per tool call.
 */
import { getChildIds, transact, type ComponentResolver } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import type { AgentRequest, ResolvedSource } from '../types/bridge'
import { AgentToolError } from './errors'
import type { DocIndex } from './docIndex'
import type { AgentGeometry } from './geometry'
import { resolveRef, type DocContext } from './model'
import { checkpointBeforeAgentWrite } from './checkpoint'

export interface AssetAccess {
  /** Store bytes in the core; resolves to their hash. */
  put(bytes: Uint8Array, mime: string): Promise<string>
  /** Whether the core has the asset. */
  has(hash: string): Promise<boolean>
  get(hash: string): Promise<Uint8Array | null>
  /** Natural pixel size of a stored raster (decoded in the DOM), or null. */
  naturalSize?(hash: string): Promise<{ width: number; height: number } | null>
}

/** Computed styles measured in the host's DOM (get_computed_styles `resolved: true`). */
export type ResolvedStylesProbe = (
  artboardId: string,
  nodeIds: readonly string[],
) => Record<string, Record<string, string>> | null

export interface HostEnv extends DocContext {
  fileId: string
  doc: LoroDoc
  resolver: ComponentResolver
  headless: boolean
  geometry: AgentGeometry
  /** Plain-object mirror for whole-file reads (built on first use). */
  index: DocIndex
  /** The file's display name (document name, else the file list's). */
  fileName(): string
  /** The page the user is viewing (visible host) or the first page (headless host). */
  currentPageId(): string
  /** True when a user is looking at this page (visible host only). */
  isViewing(pageId: string): boolean
  /** The canvas selection (empty in a headless host). */
  selection(): readonly string[]
  /** Theme-panel positions of tokens. */
  tokenOrders(): Record<string, number>
  /** Last artboard each agent session created or duplicated, per page (§6.21.1 anchors). */
  anchors: Map<string, string>
  assets: AssetAccess
  /** Switch the user's page (open_file on first open only). */
  setPage?(pageId: string): void
  /** Milliseconds since the session opened. */
  age?(): number
  /** Viewer of a shared file: writes are refused. */
  readOnly?(): Promise<boolean>
  flush?(): Promise<void>
  /** Headless hosts: flush, close the session (thumbnail) and let main destroy the window. */
  release?(): Promise<void>
  resolvedStyles?: ResolvedStylesProbe
}

export interface ToolCall {
  tool: string
  env: HostEnv
  args: Record<string, unknown>
  agent: AgentRequest['agent']
  assets: Record<string, ResolvedSource>
  signal: AbortSignal
}

export interface ToolOutput {
  result: unknown
  /** Top-level artboards read or written (contract §4.6). */
  touched?: string[]
}

export type Executor = (call: ToolCall) => ToolOutput | Promise<ToolOutput>

export interface ToolSpec {
  run: Executor
  /** Changes the document (read-only check, one commit). */
  write: boolean
  /** Result carries the `{ file, contentHash }` header (default true). */
  header?: boolean
}

export const ORIGIN_PREFIX = 'agent:'

/**
 * Run `fn` as the call's single transaction (origin `agent:<tool>`); geometry is re-measured after.
 * An agent's first write after a while records a version first (`checkpoint.ts`).
 */
export function commit<T>(call: ToolCall, fn: () => T): T {
  if (call.signal.aborted) throw new AgentToolError('cancelled', 'The request was cancelled.')
  if (call.agent) checkpointBeforeAgentWrite(call.env.doc, call.agent.name)
  try {
    return transact(call.env.doc, fn, { origin: `${ORIGIN_PREFIX}${call.tool}` })
  } finally {
    call.env.geometry.invalidate()
  }
}

// ---------------------------------------------------------------------------
// Argument helpers (main validated the shapes with zod; these narrow the types)
// ---------------------------------------------------------------------------

export function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
}

export function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v === '') {
    throw new AgentToolError('invalid_argument', `${key} is required (a non-empty string).`)
  }
  return v
}

export function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  return typeof v === 'boolean' ? v : undefined
}

export function arr(args: Record<string, unknown>, key: string): unknown[] {
  const v = args[key]
  return Array.isArray(v) ? v : []
}

export function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/** `pageId` argument (default: the user's page / the first page), checked. */
export function pageArg(env: HostEnv, pageId: string | undefined): string {
  if (pageId === undefined || pageId === '') {
    const current = env.currentPageId()
    if (current) return current
    const first = getChildIds(env.doc, null)[0]
    if (first === undefined) throw new AgentToolError('page_not_found', 'The file has no pages.')
    return first
  }
  const node = resolveRef(env, pageId)
  if (!node || node.type !== 'page') {
    throw new AgentToolError(
      'page_not_found',
      `Page ${JSON.stringify(pageId)} not found. get_basic_info lists the pages.`,
    )
  }
  return pageId
}

/** Session-scoped anchor key for artboard placement. */
export function anchorKey(call: ToolCall, pageId: string): string {
  return `${call.agent?.sessionId ?? ''}\u0000${pageId}`
}
