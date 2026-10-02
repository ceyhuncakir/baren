/**
 * Backend selection: the native Rust core when its napi module is present and
 * has the expected API, otherwise the JS fallback — so the app always runs.
 * `BAREN_CORE=native` turns a missing/broken native module into an error
 * (CI for the native path); `BAREN_CORE=js` skips the native probe.
 */
import type { Logger } from '../log'
import type { CoreMode } from '../startup/flags'
import { CoreError, type CoreBackend, type CoreBackendKind } from './types'

export interface BackendSelection {
  backend: CoreBackend
  kind: CoreBackendKind
  /** Which module was loaded, or why the native core was not used. */
  detail: string
}

export interface SelectBackendDeps {
  mode: CoreMode
  candidates: readonly string[]
  exists(path: string): Promise<boolean>
  loadNative(path: string): Promise<{ backend: CoreBackend; shape: string }>
  createJs(): CoreBackend
  log: Logger
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function selectCoreBackend(deps: SelectBackendDeps): Promise<BackendSelection> {
  if (deps.mode === 'js') {
    return { backend: deps.createJs(), kind: 'js', detail: 'BAREN_CORE=js' }
  }

  const failures: string[] = []
  for (const path of deps.candidates) {
    if (!(await deps.exists(path))) continue
    try {
      const { backend, shape } = await deps.loadNative(path)
      return { backend, kind: 'native', detail: `${path} [${shape}]` }
    } catch (error) {
      failures.push(`${path}: ${message(error)}`)
    }
  }

  const reason =
    failures.length > 0
      ? failures.join('; ')
      : `no native module at ${deps.candidates.join(', ') || '(no candidates)'}`
  if (deps.mode === 'native') {
    throw new CoreError('UNAVAILABLE', `BAREN_CORE=native but ${reason}`)
  }
  deps.log.warn('native core unavailable; using the JS fallback', reason)
  return { backend: deps.createJs(), kind: 'js', detail: reason }
}
