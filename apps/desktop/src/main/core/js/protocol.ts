/** Message protocol between main and the JS core worker thread. */
import type { CoreMethod } from '../types'

export interface WorkerInit {
  dataDir: string
}

export type WorkerMethod = CoreMethod | 'getAssetEntry' | 'flush'

/** Methods the worker answers besides the core operations. */
export const EXTRA_WORKER_METHODS = [
  'getAssetEntry',
  'flush',
] as const satisfies readonly WorkerMethod[]

export interface WorkerRequest {
  id: number
  method: WorkerMethod
  args: unknown[]
}

export interface WorkerError {
  message: string
  code?: string
}

export type WorkerResponse =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: WorkerError }

/**
 * Buffers that can be moved (not copied) to the other thread: only views
 * spanning their whole, non-shared ArrayBuffer (never a slice of a pool).
 */
export function transferables(values: readonly unknown[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  for (const value of values) {
    if (!(value instanceof Uint8Array)) continue
    const buffer = value.buffer
    if (
      buffer instanceof ArrayBuffer &&
      value.byteOffset === 0 &&
      value.byteLength === buffer.byteLength &&
      !out.includes(buffer)
    ) {
      out.push(buffer)
    }
  }
  return out
}

export function toWorkerError(error: unknown): WorkerError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? { message: error.message, code } : { message: error.message }
  }
  return { message: String(error) }
}
