/** A failed API call. `status` is 0 for network failures (server unreachable, CORS, abort). */
export class ApiError extends Error {
  override readonly name = 'ApiError'

  constructor(
    readonly status: number,
    /** Stable machine-readable code from the server, e.g. `invalid_credentials`. */
    readonly code: string,
    message: string,
  ) {
    super(message)
  }

  /** True for errors worth retrying later (network trouble, 5xx, rate limits). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}
