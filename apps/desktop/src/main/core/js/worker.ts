/**
 * Worker-thread entry of the JS fallback core. Loro (loro-crdt's web build,
 * initialised from the bundled .wasm) and blake3 hashing run here, never on
 * the Electron main thread.
 */
import { readFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { initSync } from 'loro-crdt/web'
import loroWasmPath from 'loro-crdt/web/loro_wasm_bg.wasm?asset'
import { CORE_METHODS } from '../types'
import { createLoroDocEngine, type DocEngine } from './docEngine'
import { blake3Hex } from './hash'
import { JsCore } from './jsCore'
import {
  EXTRA_WORKER_METHODS,
  toWorkerError,
  transferables,
  type WorkerInit,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol'

const port = parentPort
if (!port) throw new Error('jsCore worker must run in a worker thread')
const { dataDir } = workerData as WorkerInit

let engine: Promise<DocEngine> | null = null
function loadEngine(): Promise<DocEngine> {
  engine ??= (async () => {
    // Async compile (off-thread in V8); instantiating a compiled module is cheap.
    const module = await WebAssembly.compile(await readFile(loroWasmPath))
    initSync({ module })
    return createLoroDocEngine()
  })()
  return engine
}

const core = new JsCore({
  dataDir,
  engine: loadEngine,
  hash: blake3Hex,
  warn: (message, data) => console.warn(`[baren:js-core] ${message}`, data ?? ''),
})

// Warm up while the renderer boots; the first open/applyUpdate then pays nothing.
void loadEngine().catch((error: unknown) =>
  console.error('[baren:js-core] Loro init failed', error),
)

const METHODS: ReadonlySet<string> = new Set([...CORE_METHODS, ...EXTRA_WORKER_METHODS])

async function handle(request: WorkerRequest): Promise<void> {
  let response: WorkerResponse
  try {
    if (!METHODS.has(request.method)) throw new Error(`Unknown method: ${request.method}`)
    const fn = core[request.method] as (...args: unknown[]) => Promise<unknown>
    const value = await fn.apply(core, request.args)
    response = { id: request.id, ok: true, value }
  } catch (error) {
    response = { id: request.id, ok: false, error: toWorkerError(error) }
  }
  port?.postMessage(response, response.ok ? transferables([response.value]) : [])
}

port.on('message', (request: WorkerRequest) => {
  void handle(request)
})
