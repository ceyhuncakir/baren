import { describe, expect, it } from 'vitest'
import { createLogger } from '../log'
import { transferables, type WorkerRequest, type WorkerResponse } from './js/protocol'
import { createWorkerBackend, type WorkerLike } from './workerBackend'

const silent = createLogger('test', { sink: () => {} })

type Listener = (arg: never) => void

class FakeWorker implements WorkerLike {
  readonly requests: { message: WorkerRequest; transfer: readonly ArrayBuffer[] }[] = []
  private readonly listeners = new Map<string, Listener[]>()
  terminated = false

  constructor(private readonly reply: (req: WorkerRequest) => WorkerResponse | null) {}

  postMessage(message: unknown, transfer: readonly ArrayBuffer[] = []): void {
    const req = message as WorkerRequest
    this.requests.push({ message: req, transfer })
    const response = this.reply(req)
    if (response) queueMicrotask(() => this.emit('message', response))
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  emit(event: string, arg: unknown): void {
    for (const l of this.listeners.get(event) ?? []) (l as (a: unknown) => void)(arg)
  }

  async terminate(): Promise<number> {
    this.terminated = true
    return 0
  }
}

describe('createWorkerBackend', () => {
  it('spawns lazily and routes responses by request id', async () => {
    const workers: FakeWorker[] = []
    const backend = createWorkerBackend(() => {
      const w = new FakeWorker((req) =>
        req.method === 'listFiles'
          ? { id: req.id, ok: true, value: [] }
          : { id: req.id, ok: false, error: { message: 'File not found: x', code: 'NOT_FOUND' } },
      )
      workers.push(w)
      return w
    }, silent)
    expect(workers).toHaveLength(0)
    expect(backend.kind).toBe('js')
    expect(await backend.listFiles()).toEqual([])
    const error = await backend.openFile('x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: 'File not found: x', code: 'NOT_FOUND' })
    expect(workers).toHaveLength(1)
  })

  it('transfers whole-buffer byte arguments instead of copying them', async () => {
    let worker: FakeWorker | null = null
    const backend = createWorkerBackend(() => {
      worker = new FakeWorker((req) => ({ id: req.id, ok: true, value: undefined }))
      return worker
    }, silent)
    const update = new Uint8Array([1, 2, 3])
    await backend.applyUpdate('f', update)
    expect(worker!.requests[0]?.transfer).toEqual([update.buffer])
  })

  it('rejects in-flight calls when the worker dies and respawns on the next call', async () => {
    const workers: FakeWorker[] = []
    const backend = createWorkerBackend(() => {
      const w = new FakeWorker((req) =>
        workers.length === 1 ? null : { id: req.id, ok: true, value: [] },
      )
      workers.push(w)
      return w
    }, silent)
    const pending = backend.listFiles()
    workers[0]!.emit('error', new Error('boom'))
    await expect(pending).rejects.toThrow(/JS core worker stopped: boom/)
    expect(await backend.listFiles()).toEqual([])
    expect(workers).toHaveLength(2)
  })

  it('flushes and terminates on dispose', async () => {
    let worker: FakeWorker | null = null
    const backend = createWorkerBackend(() => {
      worker = new FakeWorker((req) => ({
        id: req.id,
        ok: true,
        value: req.method === 'listFiles' ? [] : undefined,
      }))
      return worker
    }, silent)
    await backend.listFiles()
    await backend.dispose()
    expect(worker!.requests.map((r) => r.message.method)).toEqual(['listFiles', 'flush'])
    expect(worker!.terminated).toBe(true)
  })
})

describe('transferables', () => {
  it('never transfers views that share a larger buffer (e.g. Buffer pool slices)', () => {
    const whole = new Uint8Array(8)
    const slice = new Uint8Array(new ArrayBuffer(16), 4, 8)
    expect(transferables([whole, slice, 'x', whole])).toEqual([whole.buffer])
  })
})
