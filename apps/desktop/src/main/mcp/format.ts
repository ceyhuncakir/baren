/**
 * Tool results and errors (contract §4.9, §4.10).
 *
 * File-scoped results have two blocks: a `{ file, contentHash }` header block and the body
 * (pretty JSON, or text for guides, JSX and stylesheets). Failures are tool results
 * with `isError: true` and one line `Error [<code>]: <message>`, so the model sees them.
 */
import type { AgentErrorCode, FileHeader } from '../../renderer/types/bridge'

export interface TextContent {
  type: 'text'
  text: string
}
export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}
export type ToolContent = TextContent | ImageContent

export interface ToolResult {
  [key: string]: unknown
  content: ToolContent[]
  isError?: boolean
}

/** An error a tool reports to the agent (never a JSON-RPC error). */
export class ToolError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError
}

export function headerText(header: FileHeader): string {
  return JSON.stringify(
    { file: { id: header.file.id, name: header.file.name }, contentHash: header.contentHash },
    null,
    2,
  )
}

/** Strings are sent as they are (guides, JSX, CSS); everything else as pretty JSON. */
export function bodyText(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body ?? null, null, 2)
}

export function textBlock(text: string): TextContent {
  return { type: 'text', text }
}

export function imageBlock(bytes: Uint8Array, mimeType: string): ImageContent {
  return { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType }
}

/** A successful result: `[header?, body, ...extra]`. */
export function okResult(
  header: FileHeader | null,
  body: unknown,
  extra: ToolContent[] = [],
): ToolResult {
  const content: ToolContent[] = []
  if (header) content.push(textBlock(headerText(header)))
  content.push(textBlock(bodyText(body)), ...extra)
  return { content }
}

/** One line, no newlines: what is wrong and what to call instead. */
export function errorLine(code: AgentErrorCode, message: string): string {
  return `Error [${code}]: ${message.replace(/\s*\n\s*/g, ' ').trim()}`
}

export function errorResult(
  code: AgentErrorCode,
  message: string,
  header: FileHeader | null = null,
): ToolResult {
  const content: ToolContent[] = []
  if (header) content.push(textBlock(headerText(header)))
  content.push(textBlock(errorLine(code, message)))
  return { content, isError: true }
}

/** Map anything thrown by a tool to its error result (unexpected exceptions are `internal`). */
export function resultFromError(error: unknown, header: FileHeader | null = null): ToolResult {
  if (isToolError(error)) return errorResult(error.code, error.message, header)
  const message = error instanceof Error ? error.message : String(error)
  return errorResult('internal', message || 'Unexpected error', header)
}

/**
 * Batch tools report per-entry errors in-band (`errors: [...]`); the call is an error only when
 * no entry succeeded (contract §4.9).
 */
export function batchFailed(body: unknown, successKeys: readonly string[]): boolean {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  const errors = b['errors']
  if (!Array.isArray(errors) || errors.length === 0) return false
  for (const key of successKeys) {
    const v = b[key]
    if (Array.isArray(v) && v.length > 0) return false
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0) {
      return false
    }
  }
  return true
}

/** Approximate byte size of a result (debug logs only). */
export function resultSize(result: ToolResult): number {
  let n = 0
  for (const c of result.content) n += c.type === 'text' ? c.text.length : c.data.length
  return n
}
