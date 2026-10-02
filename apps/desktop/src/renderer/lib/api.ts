/**
 * The REST client for the baren server. `@baren/sync-client/api` never loads Loro, so
 * importing this at startup keeps the WASM lazy. With `?fixture=design` (browser only) an
 * in-memory fake server answers instead.
 */
import { createApiClient, isApiError, type ApiClient } from '@baren/sync-client/api'
import { bridge } from './bridge'
import { SERVER_URL } from './env'
import { isDesignFixture } from './fixture'
import { createMockApi } from './mockApi'

export const api: ApiClient = isDesignFixture
  ? createMockApi({ serverUrl: SERVER_URL })
  : createApiClient({ baseUrl: SERVER_URL, getToken: () => bridge.auth.getToken() })

/** Network trouble, 5xx or rate limiting: worth trying again later. */
export function isTransientApiError(error: unknown): boolean {
  return isApiError(error) && error.retryable
}

/** The server could not be reached at all (offline, server down, CORS). */
export function isNetworkError(error: unknown): boolean {
  return isApiError(error) && error.status === 0
}

export function isUnauthorized(error: unknown): boolean {
  return isApiError(error) && error.status === 401
}

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (isNetworkError(error)) return "Can't reach the server. Check your connection and try again."
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong. Try again.'
}
