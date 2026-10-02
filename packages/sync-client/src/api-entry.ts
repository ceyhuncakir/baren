/**
 * `@baren/sync-client/api`: the REST client only. Safe to import from startup code — it
 * never touches `loro-crdt`.
 */

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787'

export {
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
  type TokenSource,
  type WaitForDeviceOptions,
} from './api.ts'
export { ApiError, isApiError } from './errors.ts'
export { bytesToBase64 } from './base64.ts'
export type * from './types.ts'
