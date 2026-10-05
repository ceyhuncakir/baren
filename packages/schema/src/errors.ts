export type SchemaErrorCode =
  | 'invalid-id'
  | 'node-not-found'
  | 'invalid-type'
  | 'invalid-parent'
  | 'invalid-token'
  | 'loro'
  | 'cycle'
  | 'invalid-ref'
  | 'invalid-payload'
  | 'invalid-comment'
  | 'comment-not-found'
  | 'invalid-version'
  | 'version-not-found'

/** Thrown by schema helpers when an operation would violate the document model. */
export class SchemaError extends Error {
  readonly code: SchemaErrorCode

  constructor(code: SchemaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SchemaError'
    this.code = code
  }
}

/** Loro (wasm-bindgen) throws non-Error values; normalise them into a readable message. */
export function describeLoroError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return String(err)
  } catch {
    return 'unknown Loro error'
  }
}
