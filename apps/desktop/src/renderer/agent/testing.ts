/**
 * Test helpers for the agent runtime (vitest, Node): a `HostEnv` over a plain Loro doc (declared
 * geometry only, in-memory assets) and a one-call dispatcher. Not imported by app code.
 */
import {
  createComponentResolver,
  getChildIds,
  subscribeNodes,
  type ComponentResolver,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { tokenOrders } from '../editor/model/tokenOps'
import type { AgentRequest, AgentResponse, AgentToolName } from '../types/bridge'
import type { AssetAccess, HostEnv } from './context'
import { DocIndex } from './docIndex'
import { AgentGeometry, type Measurer } from './geometry'
import { Dispatcher } from './host/dispatch'

export function memoryAssets(): AssetAccess & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  let n = 0
  return {
    store,
    async put(bytes) {
      for (const [hash, b] of store) {
        if (b.length === bytes.length && b.every((x, i) => x === bytes[i])) return hash
      }
      const hash = (++n).toString(16).padStart(64, 'a')
      store.set(hash, bytes)
      return hash
    },
    async has(hash) {
      return store.has(hash)
    },
    async get(hash) {
      return store.get(hash) ?? null
    },
    async naturalSize() {
      return { width: 64, height: 32 }
    },
  }
}

export interface TestEnvOptions {
  measurer?: Measurer | null
  selection?: string[]
  pageId?: string
  headless?: boolean
  readOnly?: boolean
  resolver?: ComponentResolver
}

export function testEnv(doc: LoroDoc, opts: TestEnvOptions = {}): HostEnv {
  const resolver = opts.resolver ?? createComponentResolver(doc)
  const ctx = { doc, resolver }
  const first = () => getChildIds(doc, null)[0] ?? ''
  let page = opts.pageId
  return {
    fileId: 'file-1',
    doc,
    resolver,
    headless: opts.headless ?? false,
    geometry: new AgentGeometry(ctx, opts.measurer ?? null),
    index: new DocIndex(doc, (listener) => subscribeNodes(doc, listener)),
    fileName: () => 'Test file',
    currentPageId: () => page ?? first(),
    isViewing: (p) => (opts.headless ? false : p === (page ?? first())),
    selection: () => opts.selection ?? [],
    tokenOrders: () => tokenOrders(doc),
    anchors: new Map(),
    assets: memoryAssets(),
    setPage: (p) => {
      page = p
    },
    age: () => 0,
    readOnly: async () => opts.readOnly === true,
  }
}

let seq = 0

/** Run one tool through a dispatcher (as main would). */
export function dispatch(
  env: HostEnv,
  tool: AgentToolName | string,
  args: unknown = {},
  extra: Partial<AgentRequest> = {},
  dispatcher = new Dispatcher(env),
): Promise<AgentResponse> {
  return dispatcher.handle({
    id: `r${++seq}`,
    fileId: env.fileId,
    tool: tool as AgentToolName,
    args,
    agent: { sessionId: 's1', presenceId: 'p1', name: 'Test' },
    deadline: Date.now() + 30_000,
    ...extra,
  })
}

/** The result of a successful call (throws with the error otherwise). */
export async function ok<T = Record<string, unknown>>(
  env: HostEnv,
  tool: string,
  args: unknown = {},
  extra: Partial<AgentRequest> = {},
): Promise<T> {
  const res = await dispatch(env, tool, args, extra)
  if (!res.ok) throw new Error(`${tool} failed: ${res.error.code} ${res.error.message}`)
  return res.result as T
}
