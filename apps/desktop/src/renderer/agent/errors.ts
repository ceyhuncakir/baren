/**
 * Errors of agent tool executors (contract §4.9). An executor throws `AgentToolError` with a
 * stable code and a one-line, actionable message; `toAgentError` maps everything else
 * (schema refusals, the html applier's refusals, unexpected exceptions) onto the same codes.
 */
import { SchemaError } from '@baren/schema'
import type { AgentError, AgentErrorCode } from '../types/bridge'

export class AgentToolError extends Error {
  readonly code: AgentErrorCode
  readonly data: Record<string, unknown> | undefined

  constructor(code: AgentErrorCode, message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = 'AgentToolError'
    this.code = code
    this.data = data
  }
}

const SCHEMA_CODES: Record<string, AgentErrorCode> = {
  'invalid-id': 'node_not_found',
  'node-not-found': 'node_not_found',
  'invalid-ref': 'node_not_found',
  'invalid-type': 'invalid_target',
  'invalid-parent': 'invalid_target',
  'invalid-token': 'invalid_argument',
  'invalid-payload': 'invalid_argument',
  'invalid-comment': 'invalid_argument',
  'comment-not-found': 'comment_not_found',
  cycle: 'cycle',
  loro: 'internal',
}

/** Codes thrown by `@baren/html`'s `HtmlApplyError` (contract §12). */
const HTML_CODES: ReadonlySet<string> = new Set([
  'node_not_found',
  'invalid_target',
  'instance_content',
  'cycle',
  'too_large',
])

/** Any thrown value → the wire error. Unexpected exceptions become `internal` (logged). */
export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentToolError) {
    return error.data === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, data: error.data }
  }
  if (error instanceof SchemaError) {
    return { code: SCHEMA_CODES[error.code] ?? 'internal', message: error.message }
  }
  if (error instanceof Error && error.name === 'HtmlApplyError') {
    const code = (error as Error & { code?: unknown }).code
    if (typeof code === 'string' && HTML_CODES.has(code)) {
      return { code: code as AgentErrorCode, message: error.message }
    }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'cancelled', message: 'The request was cancelled.' }
  }
  console.error('[agent] executor failed', error)
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error'
  return { code: 'internal', message: message || 'Unknown error' }
}

/** One per-entry error of a batch tool, reported in-band (contract §4.9). */
export interface EntryError {
  index: number
  id?: string
  code: AgentErrorCode
  message: string
}

/** An entry error from a thrown value (schema refusals keep their mapped code). */
export function entryError(index: number, id: string | undefined, error: unknown): EntryError {
  const e = toAgentError(error)
  const out: EntryError = { index, code: e.code, message: e.message }
  if (id !== undefined) out.id = id
  return out
}
